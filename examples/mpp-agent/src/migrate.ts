// Move USDC.e from a local demo wallet (legacy) to the user's Tempo Wallet: one TIP-20 transfer signed with the local key.
// Tempo has no native gas token: the fee is paid in a stablecoin (here USDC.e itself, from the sending wallet), so we send
// the balance minus an upper bound on the fee. Nothing is deleted here; see `setup --forget-local-key`.
import {
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Actions } from 'viem/tempo'

import { config } from './config.ts'

const transport = http(config.chain.rpcUrls.default.http[0], {
  fetchOptions: { headers: { 'user-agent': 'mpp-agent/1.0' } },
})
const publicClient = createPublicClient({ chain: config.chain, transport })
export const usd = (raw: bigint, digits = 2) => `$${(Number(raw) / 1e6).toFixed(digits)}`
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`

export const tokenBalance = (address: Address) =>
  publicClient.readContract({
    address: config.token,
    abi: erc20Abi,
    functionName: 'balanceOf',
    args: [address],
  })

export type SweepPlan = {
  from: Address
  to: Address
  balance: bigint
  maxFee: bigint
  amount: bigint
  gas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
}

/**
 * Null if the local wallet holds no more than dust. The fee bound comes from preparing the same transfer:
 * gas (+20%) × maxFeePerGas, which Tempo charges in the fee token's 6-decimal units (÷ 1e12).
 */
export async function planSweep(key: Hex, to: Address): Promise<SweepPlan | null> {
  const account = privateKeyToAccount(key)
  const balance = await tokenBalance(account.address)
  if (Number(balance) / 1e6 < config.dustUsd) return null
  const wallet = createWalletClient({ account, chain: config.chain, transport })
  const call = Actions.token.transfer.call(wallet, { token: config.token, to, amount: 1n })
  const prepared = (await wallet.prepareTransactionRequest({
    calls: [call],
    feeToken: config.token,
  } as never)) as { gas?: bigint; maxFeePerGas?: bigint; maxPriorityFeePerGas?: bigint }
  if (!prepared.gas || !prepared.maxFeePerGas)
    throw new Error('could not estimate the transfer fee')
  const gas = (prepared.gas * 12n) / 10n
  const maxFee = (gas * prepared.maxFeePerGas + 10n ** 12n - 1n) / 10n ** 12n
  const amount = balance - maxFee
  if (amount <= 0n) return null
  return {
    from: account.address,
    to,
    balance,
    maxFee,
    amount,
    gas,
    maxFeePerGas: prepared.maxFeePerGas,
    maxPriorityFeePerGas: prepared.maxPriorityFeePerGas ?? 0n,
  }
}

const describePlan = (p: SweepPlan) =>
  `Move ${usd(p.amount, 4)} ${config.symbol} from your local demo wallet ${short(p.from)} to your Tempo Wallet ${short(p.to)}?`

/** Sends the planned transfer and waits for it. Throws on failure; the local key is untouched either way. */
export async function sweep(key: Hex, p: SweepPlan) {
  const account = privateKeyToAccount(key)
  if (account.address !== p.from) throw new Error('key does not match the planned wallet')
  const wallet = createWalletClient({ account, chain: config.chain, transport })
  const { receipt } = await Actions.token.transferSync(wallet, {
    token: config.token,
    to: p.to,
    amount: p.amount,
    feeToken: config.token,
    gas: p.gas,
    maxFeePerGas: p.maxFeePerGas,
    maxPriorityFeePerGas: p.maxPriorityFeePerGas,
  } as never)
  if (receipt.status !== 'success')
    throw new Error(`transfer reverted (tx ${receipt.transactionHash})`)
  const [left, arrived] = await Promise.all([tokenBalance(p.from), tokenBalance(p.to)])
  return {
    hash: receipt.transactionHash,
    url: `${config.explorer}/tx/${receipt.transactionHash}`,
    left,
    toBalance: arrived,
  }
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return false
  const { createInterface } = await import('node:readline/promises')
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return /^y(es)?$/i.test((await rl.question(`${question} [y/N] `)).trim())
  } finally {
    rl.close()
  }
}

/** The interactive sweep shared by `pnpm run setup` and `pnpm run migrate`. Returns true if the local wallet is now empty. */
export async function runMigration(
  key: Hex,
  to: Address,
  opts: { yes?: boolean; dryRun?: boolean } = {},
): Promise<boolean> {
  const from = privateKeyToAccount(key).address
  const plan = await planSweep(key, to)
  if (!plan) {
    console.log(
      `  Your local demo wallet ${short(from)} holds ${usd(await tokenBalance(from))}: nothing to move.`,
    )
    return true
  }
  console.log(
    `\n  Local demo wallet balance ${usd(plan.balance)}; the network fee (paid in ${config.symbol}) is at most ${usd(plan.maxFee, 4)}, so ${usd(plan.amount, 4)} can move.`,
  )
  if (opts.dryRun) {
    console.log(`  ${describePlan(plan)}\n  Dry run: nothing was sent.`)
    return false
  }
  if (!opts.yes && !(await confirm(`  ${describePlan(plan)}`))) {
    console.log(
      `  Not moved. Your funds stay in the local demo wallet; run \`pnpm run migrate\` any time.${process.stdin.isTTY ? '' : ' (no terminal to confirm in: pass --yes)'}`,
    )
    return false
  }
  try {
    const r = await sweep(key, plan)
    console.log(`  ✓ Moved ${usd(plan.amount)}: ${r.url}`)
    console.log(`    Local demo wallet: ${usd(r.left)} · Tempo Wallet: ${usd(r.toBalance)}`)
    const empty = Number(r.left) / 1e6 < config.dustUsd
    if (empty)
      console.log(
        '  The local demo wallet is now empty. Its key is still stored; remove it with `pnpm run setup -- --forget-local-key`.',
      )
    return empty
  } catch (e) {
    console.log(
      `  ✗ The transfer did not complete: ${e instanceof Error ? e.message.split('\n')[0] : e}`,
    )
    console.log(
      '    The local key is unchanged. Check both balances, then rerun `pnpm run migrate` if the funds are still there.',
    )
    return false
  }
}
