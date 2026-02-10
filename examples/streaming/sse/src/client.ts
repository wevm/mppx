import { tempo } from 'mpay/client'
import { createClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const BASE_URL = (process.env.BASE_URL ?? 'http://localhost:5173').replace(/\/+$/, '')
const currency = '0x20c0000000000000000000000000000000000000' as const

const account = privateKeyToAccount((process.env.PRIVATE_KEY as Hex) ?? generatePrivateKey())

const client = createClient({
  account,
  chain: tempoModerato,
  pollingInterval: 1_000,
  transport: http(),
})

console.log(`Client account: ${account.address}`)
console.log('Funding account via faucet...')
await Actions.faucet.fundSync(client, { account, timeout: 30_000 })

const getBalance = () => Actions.token.getBalance(client, { account, token: currency })
const fmt = (b: bigint) => `${Number(b) / 1e6} pathUSD`

const balanceBefore = await getBalance()
console.log(`Balance: ${fmt(balanceBefore)}`)

// `session` manages the full payment channel lifecycle automatically:
//
//   1. GET  /api/chat  → server returns 402 with a payment challenge
//   2. POST /api/chat  → client sends an open-channel credential (on-chain tx)
//   3. GET  /api/chat  → client retries with a voucher; server begins SSE stream
//   4. POST /api/chat  → for each `mpay-need-voucher` SSE event, the client
//                         sends an updated cumulative voucher via POST
//                         (one POST per token — this is the streaming payment)
//   5. close()         → settles the final voucher on-chain
const s = tempo.session({
  account,
  getClient: () => client,
  maxDeposit: '10',
})

const prompt = process.argv[2] ?? 'Tell me something interesting'
console.log(`\nPrompt: ${prompt}`)

const tokens = await s.sse(`${BASE_URL}/api/chat?prompt=${encodeURIComponent(prompt)}`, {
  onReceipt(receipt) {
    console.log(`\n\nReceipt: ${receipt.spent} spent, ${receipt.units} tokens`)
    if (receipt.txHash) console.log(`Transaction: ${receipt.txHash}`)
  },
})

for await (const token of tokens) {
  process.stdout.write(token)
}

console.log(`\nVoucher cumulative: ${fmt(s.cumulative)}`)

// Settle the payment channel on-chain with the final cumulative voucher.
const closeReceipt = await s.close()
if (closeReceipt?.txHash) console.log(`Settlement tx: ${closeReceipt.txHash}`)

await new Promise((r) => setTimeout(r, 2_000))

const balanceAfter = await getBalance()
console.log(
  `\nBalance: ${fmt(balanceBefore)} → ${fmt(balanceAfter)} (spent ${fmt(balanceBefore - balanceAfter)})`,
)
