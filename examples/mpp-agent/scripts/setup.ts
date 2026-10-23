// `pnpm run setup`: approve this agent in your Tempo Wallet (an access key with a spending limit and expiry), then offer
// to move funds from a local demo wallet made by an earlier setup. Keys are never printed.
// Flags: --limit=<usd> (default 5), --days=<n> (default 7), --reauthorize (approve a new key), --no-browser,
//        --yes (move local funds without asking), --forget-local-key (delete an empty local demo wallet key),
//        --activate-only [--dry-run] (just register an approved key on chain, or estimate its fee).
// With MPP_KEY_SOURCE=keychain|file|env it creates and funds a local demo wallet instead (the old flow):
//        --no-wait (don't poll), --min=<usd> (default 1).
import { createPublicClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

import { activate, estimateActivation, keyState } from '../src/activate.ts'
import { config } from '../src/config.ts'
import {
  describeAccessKey,
  describeLegacy,
  forgetKey,
  readAccessKey,
  readKey,
  storeAccessKey,
  storeKey,
  type AccessKeyRecord,
} from '../src/keystore.ts'
import { runMigration, tokenBalance, usd } from '../src/migrate.ts'

const args = process.argv.slice(2)
const flag = (name: string) => args.includes(`--${name}`)
const opt = (name: string, d: number) => {
  const v = Number(args.find((a) => a.startsWith(`--${name}=`))?.split('=')[1])
  return v > 0 ? v : d
}
const day = (unix: number) =>
  new Date(unix * 1000).toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  })
const network =
  config.network === 'mainnet'
    ? 'Tempo mainnet (chain 4217), token USDC.e'
    : 'Tempo Moderato testnet'

if (flag('forget-local-key')) await forgetLocalKey()
else if (flag('activate-only')) await activateOnly()
else if (
  config.keySource === 'keychain' ||
  config.keySource === 'file' ||
  config.keySource === 'env'
)
  await legacySetup()
else await tempoWalletSetup()

async function tempoWalletSetup() {
  let r = readAccessKey()
  const usable = r && r.chainId === config.chain.id && r.expiry > Date.now() / 1000
  if (r && usable && !flag('reauthorize')) {
    console.log(
      `\n✓ This agent is already approved in your Tempo Wallet (key stored in ${describeAccessKey()}).`,
    )
  } else {
    if (r && !usable)
      console.log(
        `\nYour stored access key ${r.chainId !== config.chain.id ? `is for chain ${r.chainId}` : `expired on ${day(r.expiry)}`}; approving a new one.`,
      )
    const limitUsd = opt('limit', 5),
      days = opt('days', 7)
    console.log(
      `\nAsking your Tempo Wallet to let this agent spend up to $${limitUsd.toFixed(2)} ${config.symbol} for ${days} days (${network}).`,
    )
    console.log(
      `It can only make ${config.symbol} transfers, and the chain enforces the limit and expiry.`,
    )
    const { authorizeAccessKey } = await import('../src/tempoWallet.ts') // the wallet SDK is only needed here
    r = await authorizeAccessKey({ limitUsd, days, browser: !flag('no-browser') })
    storeAccessKey(r)
    console.log(`\n✓ Approved (key stored in ${describeAccessKey()}).`)
    const asked = BigInt(Math.round(limitUsd * 1e6))
    if (BigInt(r.limit.raw) !== asked)
      console.log(
        `  Note: the wallet approved a limit of ${usd(BigInt(r.limit.raw))}, not the ${usd(asked)} requested.`,
      )
  }
  console.log(
    `\n  Tempo Wallet:  ${r.wallet}  (pays; balance ${usd(await tokenBalance(r.wallet))})`,
  )
  console.log(`  Access key:    ${r.accessKey}  (this agent)`)
  console.log(
    `  Limit:         ${usd(BigInt(r.limit.raw))} ${config.symbol} · expires ${day(r.expiry)}`,
  )
  console.log(
    `  Revoke:        in the Tempo Wallet app (https://wallet.tempo.xyz), or \`tempo wallet revoke ${r.accessKey}\``,
  )

  // Register the key on chain (its fee comes from the Tempo Wallet). If that wallet is still empty but a local demo
  // wallet has funds, move those first so the fee can be paid.
  const legacy = readKey()
  const walletEmpty = Number(await tokenBalance(r.wallet)) / 1e6 < config.dustUsd
  const migrate = async () => {
    if (!legacy) return
    console.log(`\nFound a local demo wallet from an earlier setup (${describeLegacy()}).`)
    await runMigration(legacy, r.wallet, { yes: flag('yes') })
  }
  if (legacy && walletEmpty) {
    await migrate()
    await activation(r)
  } else {
    await activation(r)
    await migrate()
  }
  console.log(`\nNext:  pnpm dev   →  open http://127.0.0.1:${config.port}\n`)
}

/**
 * Fee-sponsored MPP payments refuse a not-yet-registered key, so register it now with one transaction the Tempo Wallet
 * pays for (a 0 transfer to itself, signed by the key, carrying the wallet's authorization). Idempotent.
 */
async function activation(r: AccessKeyRecord, { dryRun = false } = {}): Promise<boolean> {
  const client = createPublicClient({
    chain: config.chain,
    transport: http(config.chain.rpcUrls.default.http[0]),
  })
  const state = await keyState(client, r)
  if (state === 'active') {
    console.log('\n✓ The access key is registered on chain.')
    return true
  }
  if (state === 'revoked') {
    console.log(
      '\n✗ This access key was revoked. Approve a new one: pnpm run setup -- --reauthorize',
    )
    return false
  }
  const est = await estimateActivation(r)
  console.log(
    `\nRegistering the access key on chain: one ${config.symbol} transfer of 0 from your Tempo Wallet to itself, signed by the key.`,
  )
  console.log(`  Fee: at most ${usd(est.maxFee, 4)} ${config.symbol}, paid by your Tempo Wallet.`)
  if (dryRun) {
    console.log('  Dry run: nothing was sent.')
    return false
  }
  if ((await tokenBalance(r.wallet)) < est.maxFee) {
    console.log(
      `  ✗ Your Tempo Wallet needs at least ${usd(est.maxFee, 4)} ${config.symbol} for this. Add funds, then run: pnpm run setup -- --activate-only`,
    )
    console.log(
      '    (Otherwise the first payment registers it, as long as the wallet can pay the fee.)',
    )
    return false
  }
  try {
    const tx = await activate(r)
    console.log(`  ✓ Registered (fee $${tx.feeUsd.toFixed(4)}): ${tx.url}`)
    return true
  } catch (e) {
    console.log(`  ✗ Registration failed: ${e instanceof Error ? e.message.split('\n')[0] : e}`)
    console.log('    Nothing else changed. Retry with: pnpm run setup -- --activate-only')
    return false
  }
}

async function activateOnly() {
  const r = readAccessKey()
  if (!r || r.chainId !== config.chain.id)
    return console.log('\nNo approved access key for this network yet. Run: pnpm run setup\n')
  if (r.expiry <= Date.now() / 1000)
    return console.log(
      `\nThe access key expired on ${day(r.expiry)}. Run: pnpm run setup -- --reauthorize\n`,
    )
  console.log(`\nTempo Wallet ${r.wallet} · access key ${r.accessKey}`)
  const ok = await activation(r, { dryRun: flag('dry-run') })
  if (!ok && !flag('dry-run')) process.exitCode = 1
  console.log('')
}

/** Deletes the local demo wallet key, but only once it's empty (below dust), so funds are never stranded. */
async function forgetLocalKey() {
  const key = readKey()
  if (!key)
    return console.log(`\nNo local demo wallet key in ${describeLegacy()}: nothing to forget.\n`)
  const { address } = privateKeyToAccount(key)
  const balance = await tokenBalance(address).catch(() => null)
  if (balance === null)
    return console.log(
      `\n✗ Couldn't read the balance of ${address}, so the key was kept. Try again later.\n`,
    )
  if (Number(balance) / 1e6 >= config.dustUsd) {
    console.log(
      `\n✗ Your local demo wallet ${address} still holds ${usd(balance)}, so its key was kept.`,
    )
    console.log(`  Move the funds first: pnpm run migrate\n`)
    process.exitCode = 1
    return
  }
  forgetKey()
  console.log(
    `\n✓ Removed the local demo wallet key for ${address} (balance ${usd(balance)}) from ${describeLegacy()}.\n`,
  )
}

async function legacySetup() {
  const wait = !flag('no-wait')
  const min = opt('min', 1)
  let key = readKey()
  const created = !key
  if (!key) {
    key = generatePrivateKey()
    storeKey(key)
  }
  const { address } = privateKeyToAccount(key)
  const balance = async () => Number(await tokenBalance(address)) / 1e6

  console.log(
    `\n${created ? '✓ Created a new demo wallet' : '✓ Using your existing demo wallet'} (key stored in ${describeLegacy()})`,
  )
  console.log(`\n  Address:  ${address}\n  Network:  ${network}`)
  let usdNow = await balance()
  console.log(`  Balance:  $${usdNow.toFixed(4)}\n`)

  if (usdNow < min) {
    console.log(
      `Fund it with $2–5 of USDC.e on Tempo. It's a demo wallet: only keep what you're happy to spend.\n`,
    )
    console.log(
      `  Option A — Tempo CLI (install: curl -fsSL https://tempo.xyz/install | bash; then: tempo wallet login)`,
    )
    console.log(`    tempo wallet transfer 5 ${config.token} ${address}\n`)
    console.log(
      `  Option B — Tempo Wallet app: https://wallet.tempo.xyz → send USDC.e to the address above`,
    )
    console.log(
      `  Option C — no crypto yet? \`tempo wallet fund\` opens a card / Apple Pay top-up, then use option A.\n`,
    )
    if (!wait) process.exit(0)
    process.stdout.write(
      `Waiting for at least $${min.toFixed(2)} to arrive (Ctrl-C to stop; rerun \`pnpm run setup\` any time)…`,
    )
    while ((usdNow = await balance()) < min) {
      await new Promise((r) => setTimeout(r, 5000))
      process.stdout.write('.')
    }
    console.log(`\n\n✓ Funded: $${usdNow.toFixed(4)}`)
  }
  console.log(`\nNext:  pnpm dev   →  open http://127.0.0.1:${config.port}\n`)
}
