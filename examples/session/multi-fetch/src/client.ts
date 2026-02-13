// mppx Streaming Payment Channel — Client Example

//
// This example demonstrates a full payment channel lifecycle:
//
//   1. Open a payment channel (on-chain, once)
//   2. Make many paid requests using off-chain vouchers (no on-chain tx per request)
//   3. Close the channel (server settles on-chain, unused deposit is refunded)
//
// Payment channels let you pay for many small requests (e.g. API calls, page
// scrapes) without a separate on-chain transaction for each one. Instead, the
// client locks a deposit into an escrow contract once, then sends signed
// "vouchers" — off-chain IOUs — with each request. Only two on-chain txs are
// needed: open and close/settle.
//
// The flow for each request looks like:
//
//   Request 1 (no channel yet):
//     Client → GET /api/scrape              → Server returns 402 + challenge
//     Client opens channel on-chain (approve + open escrow)
//     Client → GET /api/scrape + voucher(1) → Server returns 200 + receipt
//
//   Request 2+ (channel already open):
//     Client → GET /api/scrape + voucher(N) → Server returns 200 + receipt
//     (no on-chain tx — just a signed message!)
//
//   Close:
//     Client → POST with close voucher      → Server settles on-chain
//     Server keeps the voucher amount, remainder refunded to client.
//

// `tempo` from 'mppx/client' provides the streaming payment session API.
// It handles the full 402 → open → voucher → close lifecycle automatically.
import { tempo } from 'mppx/client'
import { createClient, type Hex, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

const BASE_URL = process.env.BASE_URL ?? 'http://localhost:5173'

// pathUSD is the testnet TIP-20 token on Tempo Moderato (testnet).
// Address 0x20c0...0000 is the well-known pathUSD contract address.
// On testnet the faucet gives you pathUSD for free so you can experiment
// without real funds.
const currency = '0x20c0000000000000000000000000000000000000' as const

// Use the provided private key or generate a fresh one for this demo.
// In production, the client would use a real wallet/key.
const account = privateKeyToAccount((process.env.PRIVATE_KEY as Hex) ?? generatePrivateKey())

// Create a viem client connected to Tempo Moderato (testnet).
// The `account` is attached so the client can sign transactions and vouchers.
// `pollingInterval` of 1s makes block confirmations snappier for the demo.
const client = createClient({
  account,
  chain: tempoModerato,
  pollingInterval: 1_000,
  transport: http(),
})

console.log(`Client account: ${account.address}`)

// Fund the account from the testnet faucet. This gives us pathUSD tokens
// and native gas. `fundSync` blocks until the faucet tx is confirmed.
console.log('Funding account via faucet...')
await Actions.faucet.fundSync(client, { account, timeout: 30_000 })

// Helper to check our pathUSD balance (6 decimals).
const getBalance = () => Actions.token.getBalance(client, { account, token: currency })
const fmt = (b: bigint) => `${Number(b) / 1e6} pathUSD`

const balanceBefore = await getBalance()
console.log(`Balance: ${fmt(balanceBefore)}`)

// Step 1: Create a payment session

//
// `tempo.session()` creates a reusable session that manages a single payment
// channel. It handles:
//   - Receiving the 402 challenge on the first request
//   - Opening the channel on-chain (approve token + open escrow)
//   - Signing and sending incrementing cumulative vouchers on each request
//   - Closing the channel when you're done
//
// `maxDeposit` is the TOTAL amount locked into the payment channel's escrow
// contract — this is NOT the per-request cost. Think of it as the channel's
// budget or spending limit. Individual requests cost much less (e.g. 0.01
// pathUSD each), but you deposit more upfront so you can make many requests
// without opening a new channel. Any unspent deposit is refunded on close.
//
// Example: maxDeposit='1' means 1 pathUSD is locked. If each request costs
// 0.01, you can make up to 100 requests before the channel runs out.
const DEPOSIT = '1'
const s = tempo.session({
  client,
  maxDeposit: DEPOSIT,
})

console.log(`\n--- Channel ---`)
console.log(`Max deposit: ${DEPOSIT} pathUSD (locked into payment channel on first request)`)

// Step 2: Make paid requests (page scrapes)

//
// Each `s.fetch()` call follows this flow:
//
// FIRST REQUEST (lazy channel open):
//   1. Client sends a normal GET request (no credentials)
//   2. Server responds with 402 + WWW-Authenticate challenge header
//   3. Session sees the 402, builds an on-chain "open" transaction:
//      - Approves the escrow contract to spend `maxDeposit` of pathUSD
//      - Calls `open()` on the escrow contract, locking the deposit
//      - Signs an initial voucher for the first request's cost (0.01)
//   4. Sends the open credential (containing the signed tx + voucher)
//      to the server, which broadcasts the tx and verifies the voucher
//   5. Server returns 200 + the scraped content + a Payment-Receipt header
//
// SUBSEQUENT REQUESTS (off-chain vouchers only):
//   1. Session already knows the challenge params (they're deterministic —
//      same realm, method, intent, amount, currency, recipient → same HMAC ID)
//   2. Session increments the cumulative voucher amount:
//        Request 2: voucher for 0.02 (cumulative)
//        Request 3: voucher for 0.03 (cumulative)
//        ...etc
//      Vouchers are CUMULATIVE, not incremental — each voucher replaces the
//      previous one. The server only needs the latest voucher to claim all
//      owed funds.
//   3. Session signs the voucher (EIP-712 typed data) and sends it in the
//      Authorization header — no on-chain transaction needed!
//   4. Server verifies the voucher signature and that the cumulative amount
//      increased by at least the request cost, then returns 200
//
// KEY INSIGHT: After the first request, every subsequent request is just a
// signed message — no gas, no block confirmation, instant settlement.
const PAGE_COUNT = 9
const urls = Array.from({ length: PAGE_COUNT }, (_, i) => `https://example.com/page/${i + 1}`)

console.log(`\n--- Scraping ${PAGE_COUNT} pages @ 0.01 pathUSD each ---`)

for (const url of urls) {
  // s.fetch() is a drop-in replacement for `fetch()`. It automatically
  // handles 402 responses, channel opening, and voucher signing.
  const response = await s.fetch(`${BASE_URL}/api/scrape?url=${encodeURIComponent(url)}`)

  if (!response.ok) {
    console.error(`Error: ${response.status}`)
    console.error(await response.text())
    process.exit(1)
  }

  const _data = await response.json()

  // `s.cumulative` tracks the running cumulative voucher amount.
  // After 3 requests at 0.01 each, cumulative = 0.03 (30000 raw units).
  //
  // Note: receipt.reference (the channel-open tx hash) stays constant for the
  // entire session — it's always the same channel. And challenge.id (the HMAC
  // over realm|method|intent|request params) is also the same every time,
  // because the server is issuing identical challenges for the same endpoint.
  // This is what makes the protocol stateless: the server recomputes the HMAC
  // instead of looking up stored challenges.
  console.log(`  ${url} → OK (voucher cumulative: ${fmt(s.cumulative)})`)
}

console.log(`\nVoucher cumulative: ${fmt(s.cumulative)} (${PAGE_COUNT} × 0.01)`)

// Step 3: Close the channel and settle on-chain

//
// `s.close()` triggers the settlement flow:
//
//   1. Client signs a final voucher with action='close' at the current
//      cumulative amount and sends it to the server
//   2. Server verifies the voucher, then calls `close()` on the escrow
//      contract on-chain, submitting the highest cumulative voucher
//   3. The escrow contract transfers the voucher amount to the server
//      (the payee) and refunds the remainder to the client (the payer)
//
// Example with our numbers:
//   - Deposit: 1.00 pathUSD locked in escrow
//   - Voucher cumulative: 0.09 pathUSD (9 pages × 0.01)
//   - Server receives: 0.09 pathUSD
//   - Client refund: 0.91 pathUSD (1.00 - 0.09)
//
// The close receipt includes:
//   - channelId: deterministic hash of channel params (payer, payee, token, deposit, salt, etc.)
//   - acceptedCumulative: the voucher amount the server accepted and settled
//   - txHash: the on-chain settlement transaction hash (if server submitted it)
console.log(`\n--- Settlement ---`)
const closeReceipt = await s.close()
if (closeReceipt) {
  console.log(`  Channel:    ${closeReceipt.channelId}`)
  console.log(
    `  Settled:    ${closeReceipt.acceptedCumulative} raw (${fmt(BigInt(closeReceipt.acceptedCumulative))})`,
  )
  if (closeReceipt.txHash) console.log(`  Settle tx:  ${closeReceipt.txHash}`)
  else console.log(`  Settle tx:  (none — server may not have submitted)`)
}

// Wait for the settlement transaction to confirm on-chain before checking
// our final balance. The close tx needs to be mined so the refund shows up.
await new Promise((r) => setTimeout(r, 5_000))

// Step 4: Summary — see where the money went

//
// The balance difference reflects:
//   - The voucher total (0.09 pathUSD paid to the server)
//   - Gas costs for the channel open tx (small, paid in native token)
//   - The close/settle tx gas is paid by the SERVER (it submits the close tx)
//
// So: totalSpent ≈ voucherTotal + openGas
// The unused deposit (1.00 - 0.09 = 0.91) is refunded automatically by the
// escrow contract during settlement.
const balanceAfter = await getBalance()
const totalSpent = balanceBefore - balanceAfter
console.log(`\n--- Summary ---`)
console.log(`  Pages scraped:   ${PAGE_COUNT}`)
console.log(`  Voucher total:   ${fmt(s.cumulative)}`)
console.log(`  Channel deposit: ${DEPOSIT} pathUSD`)
console.log(`  Balance before:  ${fmt(balanceBefore)}`)
console.log(`  Balance after:   ${fmt(balanceAfter)}`)
console.log(`  Total spent:     ${fmt(totalSpent)} (deposit - refund + gas)`)
