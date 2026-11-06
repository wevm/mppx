// Prepaid API client with automatic and manual top-ups — Example
//
// 1. The first request opens a channel with the server's suggested deposit.
// 2. Each request pays with an off-chain voucher (no transaction).
// 3. When the deposit is used up, the manager tops up the same channel
//    on-chain by `topUpAmount`, then retries the request. `maxDeposit` caps
//    the total ever locked in the channel.
// 4. `session.topUp()` adds funds ahead of time, such as when a user buys
//    credits, so later requests never wait for a transaction.
// 5. `session.close()` settles what was spent and refunds the rest.
//
//   pnpm client                              # against wrangler dev
//   BASE_URL=https://<worker>.workers.dev pnpm client
import { tempo } from 'mppx/client'
import { createClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { Actions, Chain } from 'viem/tempo'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:8787'
const currency = '0x20c0000000000000000000000000000000000000' as const

const account = privateKeyToAccount((process.env.PRIVATE_KEY as Hex) ?? generatePrivateKey())
const client = createClient({
  account,
  chain: Chain.testnet,
  pollingInterval: 1_000,
  transport: http(),
})
console.log(`Client account: ${account.address}`)

console.log('Funding account via faucet...')
await Actions.faucet.fundSync(client, { account, timeout: 30_000 })

const getBalance = async () =>
  (await Actions.token.getBalance(client, { account, token: currency })).amount
const fmt = (amount: bigint) => `${Number(amount) / 1e6} pathUSD`
const balanceBefore = await getBalance()

const session = tempo.session.manager({
  account,
  client,
  // Never lock more than 0.2 in the channel, however many top-ups.
  maxDeposit: '0.2',
  // Top up 0.05 (5 requests) at a time when the deposit runs out.
  topUpAmount: '0.05',
})

async function search(query: string) {
  const response = await session.fetch(`${BASE_URL}/api/search?q=${encodeURIComponent(query)}`)
  if (!response.ok) throw new Error(`${response.status}: ${await response.text()}`)
  const body = (await response.json()) as { results: { title: string }[] }
  const deposit = depositOf(session)
  console.log(
    `  ${query.padEnd(10)} paid ${fmt(session.cumulative).padEnd(14)} deposit ${fmt(deposit).padEnd(14)} ${body.results[0]!.title}`,
  )
  return deposit
}

console.log('\n--- Automatic top-ups ---')
let deposit = 0n
for (let i = 1; i <= 8; i++) {
  const next = await search(`query ${i}`)
  if (deposit !== 0n && next > deposit) console.log(`  ↑ topped up by ${fmt(next - deposit)}`)
  deposit = next
}

console.log('\n--- Manual top-up (prefund 0.1) ---')
await session.topUp('0.1')
deposit = depositOf(session)
console.log(`  deposit now ${fmt(deposit)}`)
for (let i = 9; i <= 12; i++) await search(`query ${i}`)

console.log('\n--- Settlement ---')
const receipt = await session.close()
if (receipt) {
  console.log(`  Channel:   ${receipt.channelId}`)
  console.log(
    `  Settled:   ${fmt(BigInt(receipt.acceptedCumulative))} for ${receipt.units} requests`,
  )
  console.log(`  Settle tx: ${receipt.txHash ?? '(pending)'}`)
}

await new Promise((resolve) => setTimeout(resolve, 5_000))
console.log(`  Spent:     ${fmt(balanceBefore - (await getBalance()))} (requests + gas)`)

// The channel's current deposit, from the manager's state (raw units).
function depositOf(manager: typeof session): bigint {
  return 'deposit' in manager.state ? BigInt(manager.state.deposit) : 0n
}
