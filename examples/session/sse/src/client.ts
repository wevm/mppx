// SSE Streaming Payment Client — Example
//
// Opens a payment channel on the first request, streams tokens while paying
// for each one with an off-chain voucher, then closes the channel so the
// server settles on-chain and refunds the unspent deposit.
//
//   pnpm client                              # against wrangler dev
//   BASE_URL=https://<worker>.workers.dev pnpm client "Your prompt"
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

// The manager opens the channel lazily (at most `maxDeposit` locked in
// escrow), signs a cumulative voucher whenever the stream asks for more, and
// closes the channel at the end.
const session = tempo.session.manager({ account, client, maxDeposit: '1' })

const prompt = process.argv[2] ?? 'Tell me something interesting'
console.log(`\n--- Streaming (prompt: "${prompt}") ---`)
let tokens = 0
for await (const token of await session.sse(`${BASE_URL}/api/chat/${encodeURIComponent(prompt)}`)) {
  tokens++
  process.stdout.write(token)
}
console.log(`\n\nTokens: ${tokens}, paid: ${fmt(session.cumulative)}`)

console.log('\n--- Settlement ---')
const receipt = await session.close()
if (receipt) {
  console.log(`  Channel:   ${receipt.channelId}`)
  console.log(`  Settled:   ${fmt(BigInt(receipt.acceptedCumulative))}`)
  console.log(`  Settle tx: ${receipt.txHash ?? '(pending)'}`)
}

await new Promise((resolve) => setTimeout(resolve, 5_000))
console.log(`  Spent:     ${fmt(balanceBefore - (await getBalance()))} (vouchers + gas)`)
