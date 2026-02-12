// SSE Streaming Payment Client — Example

//
// This example demonstrates the client side of a metered Server-Sent Events
// (SSE) streaming session using mpay's "Payment" HTTP Authentication Scheme.
//
// The flow works like this:
//
//   1. Client creates a "session" — a lightweight wrapper around a payment
//      channel. The channel is lazily opened on-chain when the first request
//      gets a 402 response.
//
//   2. Client calls `s.sse(url)` which triggers the multi-phase HTTP flow:
//
//        GET  /api/chat  (no auth)    → Server responds 402 + WWW-Authenticate challenge
//        POST /api/chat  (open cred)  → Client sends signed on-chain open tx + initial voucher
//                                       Server broadcasts tx, verifies voucher, responds 200
//        GET  /api/chat  (voucher)    → Client sends voucher credential, server begins SSE stream
//
//   3. During the SSE stream, the server emits `payment-need-voucher` events
//      whenever it needs more payment (one per token). The client automatically
//      intercepts these events and responds with a POST containing an updated
//      cumulative voucher — no new on-chain transactions, just signatures.
//
//   4. After all tokens are received, `s.close()` sends a final voucher and
//      the server settles the channel on-chain, returning any unspent deposit.
//

// `tempo` from 'mpay/client' provides the session API for Tempo payment channels.
// A session manages the full lifecycle: open → voucher → close.
import { tempo } from 'mpay/client'
import { createClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
// `tempoModerato` is Tempo's testnet chain (like Ethereum's Sepolia/Goerli).
import { tempoModerato } from 'viem/chains'
// `Actions` provides Tempo-specific viem actions: faucet funding, token balances, etc.
import { Actions } from 'viem/tempo'

// The server URL. Defaults to localhost for local development.
const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'

// pathUSD is a TIP-20 token on Tempo's testnet (Moderato).
// This is the contract address for pathUSD — `0x20c0...` is the well-known
// testnet address. TIP-20 is Tempo's token standard (analogous to ERC-20).
// All amounts in this example are denominated in pathUSD with 6 decimals,
// so 1 pathUSD = 1_000_000 raw units.
const currency = '0x20c0000000000000000000000000000000000000' as const

// The price the server charges per streamed token (set in server.ts).
// At $0.000075 per token, streaming 1000 tokens costs $0.075 pathUSD.
const PRICE_PER_TOKEN = '0.000075'

// Create a viem account from a private key. In production you'd use a real
// key; here we generate a fresh ephemeral one for the demo. This account
// will be the "payer" in the payment channel.
const account = privateKeyToAccount((process.env.PRIVATE_KEY as Hex) ?? generatePrivateKey())

const client = createClient({
  account,
  chain: tempoModerato,
  pollingInterval: 1_000,
  transport: http(),
})
console.log(`Client account: ${account.address}`)

// Fund the account via Tempo's testnet faucet. This gives us pathUSD and
// native tokens for gas. `fundSync` waits until the funding tx confirms.
console.log('Funding account via faucet...')
await Actions.faucet.fundSync(client, { account, timeout: 30_000 })

// Helper to query the on-chain pathUSD balance of our account.
const getBalance = () => Actions.token.getBalance(client, { account, token: currency })

// Format a raw token amount (bigint with 6 decimals) into human-readable form.
// e.g., 1_000_000n → "1 pathUSD"
const fmt = (b: bigint) => `${Number(b) / 1e6} pathUSD`

const balanceBefore = await getBalance()
console.log(`Balance: ${fmt(balanceBefore)}`)

// Step 1: Create a Session

//
// `tempo.session()` creates a payment session — a stateful object that manages
// the full payment channel lifecycle for SSE streaming.
//
// Key parameters:
//
//   `account` — The viem account (private key) used to sign vouchers. SSE
//   streaming requires client-side signing because the client must produce
//   new signed vouchers mid-stream (every time the server requests payment
//   for a token). This is different from simple request/response payments
//   where the server can handle everything.
//
//   `getClient: () => client` — A function that returns the viem client.
//   The session needs this to sign EIP-712 typed data (vouchers) and to
//   prepare/sign on-chain transactions when opening the channel. Using a
//   getter function (instead of passing the client directly) allows lazy
//   resolution and supports multi-chain setups.
//
//   `maxDeposit` — The maximum amount of pathUSD to lock into the payment
//   channel on-chain. This is NOT the per-token cost — it's the total budget
//   for the entire session. When the channel is opened, this amount is
//   transferred to an escrow contract. At settlement, only the amount
//   actually spent (sum of all vouchers) goes to the server; the rest is
//   refunded to the client.
//
const DEPOSIT = '1'
const s = tempo.session({
  account,
  maxDeposit: DEPOSIT,
})

console.log(`\n--- Channel ---`)
console.log(`Max deposit: ${DEPOSIT} pathUSD (locked into payment channel on first request)`)
console.log(`Price per token: ${PRICE_PER_TOKEN} pathUSD`)

// Step 2: Stream Tokens via SSE

//
// `s.sse(url)` initiates a metered SSE streaming session. Under the hood,
// it orchestrates a multi-phase HTTP flow:
//
//   Phase 1 — GET (no auth):
//     The client sends a plain GET request to the server.
//     The server responds with 402 Payment Required + a WWW-Authenticate
//     header containing a Payment challenge (method, intent, amount, etc.)
//
//   Phase 2 — POST (open channel):
//     The client parses the 402 challenge, creates an on-chain payment
//     channel by signing a transaction that:
//       a) Approves the escrow contract to spend `maxDeposit` pathUSD
//       b) Opens a channel in the escrow contract (deposits funds)
//     It also signs an initial EIP-712 voucher and sends both in a POST.
//     The server broadcasts the tx, verifies the channel is open, and
//     responds 200.
//
//   Phase 3 — GET (start SSE stream):
//     With the channel now open, the client sends another GET with a
//     voucher credential in the Authorization header. The server begins
//     streaming SSE events.
//
//   Phase 4 — POST (mid-stream vouchers):
//     During the stream, whenever the server needs payment for the next
//     token, it emits a `payment-need-voucher` SSE event. The client's SSE
//     iterator automatically intercepts this event, signs a new cumulative
//     voucher (incrementing by `PRICE_PER_TOKEN`), and sends it via POST.
//     The server receives the voucher, updates its channel state, and
//     continues streaming. This happens transparently — the consumer of
//     the async iterator only sees the content tokens.
//
// The return value is an `AsyncIterable<string>` — each yielded value is
// a content token (word/fragment) from the server's response. The payment
// negotiation happens entirely behind the scenes.
//
const prompt = process.argv[2] ?? 'Tell me something interesting'

console.log(`\n--- Streaming (prompt: "${prompt}") ---`)

let tokenCount = 0

// `s.sse()` returns a Promise<AsyncIterable<string>>. The promise resolves
// once the channel is open and the SSE stream has started (phases 1-3 above).
// The async iterable then yields tokens as they arrive.
const tokens = await s.sse(`${BASE_URL}/api/chat?prompt=${encodeURIComponent(prompt)}`)

// Consume the SSE stream. Each iteration yields one content token.
// Behind the scenes, between tokens, the client may be handling
// `payment-need-voucher` events and sending updated vouchers via POST.
// Each voucher is cumulative — it represents the total amount spent so far,
// not just the latest increment. For example:
//   Token 1: voucher for 0.000075 pathUSD
//   Token 2: voucher for 0.000150 pathUSD
//   Token 3: voucher for 0.000225 pathUSD
//   ...
// This cumulative design means the server only needs to verify and store
// the latest voucher — it always supersedes all previous ones.
for await (const token of tokens) {
  tokenCount++
  process.stdout.write(token)
}

console.log(`\n\nTokens: ${tokenCount}`)
// `s.cumulative` reflects the total cumulative voucher amount — the sum of
// all per-token charges. This is a bigint in raw units (6 decimals).
console.log(`Voucher cumulative: ${fmt(s.cumulative)} (${tokenCount} × ${PRICE_PER_TOKEN})`)

// Step 3: Close the Channel & Settle On-Chain

//
// `s.close()` sends a final "close" credential to the server via POST.
// This tells the server the session is complete and it should settle the
// payment channel on-chain.
//
// Settlement means the server calls the escrow contract's `settle` function
// with the highest cumulative voucher. The escrow contract:
//   1. Transfers the voucher amount to the server (payee)
//   2. Refunds the remaining deposit to the client (payer)
//
// The returned `StreamReceipt` contains:
//   - `channelId`: The unique identifier of the payment channel
//   - `acceptedCumulative`: The highest voucher amount the server accepted
//     (in raw units). Should match `s.cumulative`.
//   - `units`: Number of charge operations (tokens) fulfilled
//   - `txHash`: The on-chain settlement transaction hash (if the server
//     has already submitted it). May be absent if the server settles
//     asynchronously.
//
console.log(`\n--- Settlement ---`)
const closeReceipt = await s.close()
if (closeReceipt) {
  console.log(`  Channel:    ${closeReceipt.channelId}`)
  console.log(
    `  Settled:    ${closeReceipt.acceptedCumulative} raw (${fmt(BigInt(closeReceipt.acceptedCumulative))})`,
  )
  console.log(`  Tokens:     ${closeReceipt.units}`)
  if (closeReceipt.txHash) console.log(`  Settle tx:  ${closeReceipt.txHash}`)
  else console.log(`  Settle tx:  (none — server may not have submitted)`)
}

// Wait a few seconds for the settlement transaction to confirm on-chain
// before checking the final balance. The escrow refund happens in the
// same transaction as settlement.
await new Promise((r) => setTimeout(r, 5_000))

// Step 4: Summary

//
// The final balance difference reflects three components:
//   1. The deposit amount that was locked into the escrow (debited)
//   2. The refund of unspent deposit (credited back after settlement)
//   3. Gas fees for the channel open transaction
//
// So: totalSpent ≈ voucherTotal + gasFees
// (The deposit itself is not "spent" — only the voucher amount is transferred
// to the server. The rest comes back as a refund.)
//
const balanceAfter = await getBalance()
const totalSpent = balanceBefore - balanceAfter
console.log(`\n--- Summary ---`)
console.log(`  Tokens streamed: ${tokenCount}`)
console.log(`  Voucher total:   ${fmt(s.cumulative)}`)
console.log(`  Channel deposit: ${DEPOSIT} pathUSD`)
console.log(`  Balance before:  ${fmt(balanceBefore)}`)
console.log(`  Balance after:   ${fmt(balanceAfter)}`)
console.log(`  Total spent:     ${fmt(totalSpent)} (deposit - refund + gas)`)
