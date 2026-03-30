// mppx Streaming Payment Channel — Server Example

//
// This server demonstrates how to charge per-request using payment channels.
// It exposes a `/api/scrape` endpoint that costs 0.01 pathUSD per page.
//
// The server's role in the payment channel flow:
//
//   1. CHALLENGE: When a request arrives without credentials, return 402 with
//      a WWW-Authenticate header containing the payment challenge (amount,
//      currency, recipient, method details).
//
//   2. OPEN: When the client sends an "open" credential (containing a signed
//      on-chain transaction + initial voucher), broadcast the tx to open the
//      escrow channel on-chain, verify the voucher, and return 200.
//
//   3. VOUCHER: On subsequent requests, the client sends incrementing cumulative
//      vouchers. The server verifies the signature, checks that the cumulative
//      amount increased by at least the request cost, and returns the content.
//
//   4. CLOSE: When the client sends a "close" credential, the server submits
//      the final voucher to the escrow contract on-chain, which transfers
//      the owed amount to the server and refunds the remainder to the client.
//

import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'

// `Mppx` is the server-side payment handler that manages challenges, credential
// verification, and receipt generation. `tempo` provides the Tempo-specific
// streaming payment method.
import { Mppx, tempo } from '../../../_shared/mppxSource.server.js'

// Generate a fresh keypair for the server on each start.
// In production, you'd use a persistent key stored securely.
// This account serves two purposes:
//   1. It's the `recipient` — the address that receives payment channel funds
//   2. It signs the on-chain close/settle transaction when the channel closes
const account = privateKeyToAccount(generatePrivateKey())

// pathUSD testnet TIP-20 token address on Tempo Moderato.
// Must match what the client uses — both sides need to agree on the token.
const currency = '0x20c0000000000000000000000000000000000000' as const

// The viem client MUST have an `account` attached. This is critical because
// the server needs to sign on-chain transactions when closing/settling
// payment channels. Without an account, `closeOnChain()` in the stream
// handler will fail, and the server won't be able to claim its funds.
//
// `pollingInterval: 1_000` makes block polling faster for demo responsiveness.
const client = createClient({
  account,
  chain: tempoModerato,
  pollingInterval: 1_000,
  transport: http(process.env.MPPX_RPC_URL),
})

// Payment handler setup

//
// `Mppx.create()` builds a payment handler from one or more payment methods.
// Each method defines how challenges are issued, credentials are verified,
// and receipts are generated.
//
// `tempo.session()` creates a streaming payment method that handles the full
// payment channel lifecycle:
//   - Issues 402 challenges with method-specific details (escrow contract,
//     chain ID, fee payer preferences)
//   - Verifies channel open transactions and initial vouchers
//   - Validates incrementing cumulative vouchers on each request
//   - Handles channel close by submitting the final voucher on-chain
//   - Tracks channel state in memory (or a custom storage backend)
//
// Configuration:
//   - `currency`: The TIP-20 token address to accept payment in
//   - `recipient`: The server's address that receives funds on settlement
//   - `testnet: true`: Uses Tempo Moderato testnet defaults (chain ID, escrow contract)
//   - `getClient: () => client`: Returns an account-bearing viem client.
//     The server needs this to:
//       (a) Read on-chain channel state (deposit, settled amounts)
//       (b) Broadcast the client's open transaction
//       (c) Submit close/settle transactions to claim funds
//     If you omit the account from the client, channel opens will work (the
//     client's signed tx is broadcast) but closes will silently fail — the
//     server can't sign the settle tx without a key.
const mppx = Mppx.create({
  methods: [
    tempo.session({
      account,
      currency,
      feePayer: true,
      testnet: true,
      getClient: () => client,
    }),
  ],
})

// Request handler

//
// This is a standard Request → Response handler (works with any framework
// that uses the Fetch API Request/Response types — Bun, Deno, Vite, etc.).
export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  // Health check endpoint — no payment required.
  if (url.pathname === '/api/health') return Response.json({ status: 'ok' })

  if (url.pathname === '/api/scrape') {
    const pageUrl = url.searchParams.get('url') ?? 'https://example.com'

    // `mppx.session()` returns a curried function:
    //   mppx.session({ amount, unitType }) → (request) → result
    //
    // The first call configures the per-request payment parameters:
    //   - `amount: '0.01'` — each request costs 0.01 pathUSD (in human units, 6 decimals)
    //   - `unitType: 'page'` — descriptive label for what the client is paying for
    //
    // The second call `(request)` processes the actual HTTP request. It:
    //   1. Checks for an Authorization header with a Payment credential
    //   2. If missing: returns { status: 402, challenge: Response } with WWW-Authenticate header
    //   3. If present: verifies the credential (HMAC check, voucher signature, cumulative amount)
    //      and returns { status: 200, withReceipt: fn }
    //
    // The challenge is deterministic: same (realm, method, intent, amount, currency, recipient)
    // always produces the same HMAC-bound challenge ID. This means the server is stateless —
    // it doesn't need to store issued challenges. When the client echoes back the challenge
    // in its credential, the server just recomputes the HMAC and verifies it matches.
    const result = await mppx.session({
      amount: '0.01',
      unitType: 'page',
    })(request)

    // If status is 402, the request had no valid credential.
    // Return the challenge response (402 + WWW-Authenticate header) to the client.
    // The client's session will automatically parse this, open a channel, and retry.
    if (result.status === 402) return result.challenge

    // If we get here, the credential was valid — the client paid for this request.
    // Generate the content they paid for.
    const content = scrapePage(pageUrl)

    // `result.withReceipt()` wraps the response with a `Payment-Receipt` header.
    // The receipt is a base64url-encoded JSON object containing:
    //   - status: 'success'
    //   - method: 'tempo'
    //   - intent: 'session'
    //   - timestamp: ISO 8601
    //   - reference: the channel ID (same for all requests in a session)
    //   - challengeId: the HMAC-bound challenge ID
    //   - channelId: same as reference
    //   - acceptedCumulative: the highest cumulative voucher amount accepted
    //   - spent: total amount consumed from the channel so far
    //   - units: number of paid units consumed
    //
    // The client can use this receipt to verify the server acknowledged payment.
    return result.withReceipt(Response.json({ content, url: pageUrl }))
  }

  // Return null for unhandled routes (let the framework handle 404s).
  return null
}

// Simulated scraping function. In a real app, this would fetch and parse
// the actual URL. The point is that this work only happens AFTER payment
// is verified — the server never does expensive work for free.
function scrapePage(url: string): string {
  return `<h1>${url}</h1><p>Scraped content from ${url}</p>`
}

// Server startup

//
// Fund the server account from the testnet faucet. The server needs a small
// amount of native gas to submit close/settle transactions on-chain.
// It does NOT need pathUSD — it only receives pathUSD from client channels.
console.log(`Server recipient: ${account.address}`)
await Actions.faucet.fundSync(client, { account, timeout: 30_000 })
console.log('Server account funded')
