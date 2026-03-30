// SSE Streaming Payment Server — Example

//
// This example demonstrates the server side of a metered Server-Sent Events
// (SSE) streaming session using mppx's "Payment" HTTP Authentication Scheme.
//
// The server charges per-token during an SSE stream. The full flow on a
// single endpoint (`/api/chat`) handles four distinct request phases:
//
//   GET  (no auth)     → 402 Payment Required + WWW-Authenticate challenge
//   POST (open cred)   → Verify on-chain channel open, return 200
//   GET  (with voucher)→ Begin SSE stream, charging per token
//   POST (voucher)     → Receive incremental voucher updates mid-stream
//
// The server never stores payment state in memory variables — it uses
// `Store.memory()` which is shared between the stream method and the
// SSE transport so that mid-stream voucher POSTs can update channel state
// while the SSE generator is running.
//

import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
// `Actions` provides Tempo-specific viem actions (faucet, token ops, etc.)
import { Actions } from 'viem/tempo'

// `Mppx` is the server-side payment handler. `tempo` provides Tempo-specific
// payment method implementations (stream channels, SSE transport, storage).
import { Mppx, Store, tempo } from '../../../_shared/mppxSource.server.js'

// Server Account Setup

//
// Generate a fresh keypair for this demo server. In production, you'd use a
// persistent key stored securely. This account is the "payee" (recipient) in
// the payment channel — funds flow from the client's channel deposit to this
// address when the channel is settled on-chain.
const account = privateKeyToAccount(generatePrivateKey())

// pathUSD — TIP-20 token on Tempo testnet (Moderato).
// Address `0x20c0...` is the well-known testnet pathUSD contract.
// All payment amounts in this example are denominated in pathUSD (6 decimals).
const currency = '0x20c0000000000000000000000000000000000000' as const

// Price charged per streamed token. The server emits a `payment-need-voucher`
// SSE event for each token, and the client must respond with an updated
// cumulative voucher covering this amount before the next token is sent.
const pricePerToken = '0.000075'

// Viem Client
//
// The viem client MUST have an `account` attached. This is critical because
// the server needs to sign on-chain transactions when closing/settling
// payment channels and co-signing fee-payer transactions.
const client = createClient({
  account,
  chain: tempoModerato,
  pollingInterval: 1_000,
  transport: http(),
})

// Shared Channel Store

//
// `Store.memory()` creates an in-memory store for payment channel state.
// This is the critical piece that connects the SSE stream to mid-stream
// voucher updates.
//
// Here's why shared storage matters:
//
// During an SSE stream, two things happen concurrently:
//   1. The SSE generator yields tokens and calls `stream.charge()` per token.
//      `charge()` atomically deducts from the channel's available balance in
//      storage. If the balance is insufficient, it emits a `payment-need-voucher`
//      event and polls storage waiting for the balance to increase.
//
//   2. The client receives the `payment-need-voucher` event and sends a POST
//      with an updated cumulative voucher. This POST hits the same endpoint,
//      is intercepted by the SSE transport, and updates the channel's
//      `highestVoucherAmount` in storage.
//
// Because both the SSE generator (step 1) and the voucher POST handler
// (step 2) share the same `store` instance, the generator's poll
// immediately sees the new balance and continues streaming. The storage
// also supports `waitForUpdate()` for event-driven wakeups instead of
// polling, which `Store.memory()` implements via a simple waiter set.
//
// In production, you'd replace this with a durable storage backend
// (e.g., Cloudflare Durable Objects, a database with transactions) to
// survive server restarts and support horizontal scaling.
const store = Store.memory()

// Mppx Server Instance

//
// `Mppx.create()` assembles the payment handler from method intents.
//
//   `methods` — An array of payment method handlers. Here we use
//   `tempo.session()` which implements the Tempo streaming payment channel
//   protocol. It handles:
//     - Generating 402 challenges with the correct payment parameters
//     - Verifying "open" credentials (checking the on-chain channel exists)
//     - Verifying "voucher" credentials (validating EIP-712 signatures)
//     - Verifying "close" credentials and settling on-chain
//
//   `transport` — Each method intent can specify its own transport.
//   `Transport.sse()` wires up SSE-specific behavior:
//     - When the response is an async generator, it wraps it in an SSE
//       ReadableStream with proper headers (text/event-stream, etc.)
//     - It handles mid-stream voucher POSTs by detecting them as "managed"
//       requests and processing the voucher update without invoking the
//       application's stream generator
//     - It extracts channelId, challengeId, and tickCost from the
//       Authorization header to configure the SSE metering loop
//
const mppx = Mppx.create({
  methods: [
    tempo.session({
      // The server's account — where settled funds are transferred to.
      // Passing the Account object (not just .address) allows the server
      // to co-sign transactions when `feePayer` is enabled.
      account,
      // The TIP-20 token to accept payment in.
      currency,
      // Enable fee-sponsored transactions. When true, the server co-signs
      // the client's channel-open transaction so the protocol covers gas
      // fees instead of the client paying them.
      feePayer: true,
      // Returns an account-bearing viem client for on-chain operations:
      // broadcasting channel-open txs, verifying channel state, and
      // submitting close/settle transactions.
      getClient: () => client,
      // Shared store so mid-stream voucher POSTs update the same state
      // that `stream.charge()` reads from.
      store,
      // SSE transport for streaming. The session method detects the SSE
      // transport and wires up Tempo metering (per-token charging, voucher
      // handling) automatically using the shared storage.
      sse: true,
      // Enable testnet mode (relaxes certain validation constraints).
      testnet: true,
    }),
  ],
})

// Request Handler

//
// This is a framework-agnostic request handler (works with any runtime that
// supports the standard Request/Response API — Bun, Deno, Cloudflare Workers,
// or Node with a compatibility layer).
//
// The key insight is that a SINGLE endpoint (`/api/chat`) handles ALL four
// phases of the payment flow. The server distinguishes phases by HTTP method
// and the presence/type of the Authorization header:
//
//   Phase 1 — GET, no Authorization header:
//     First contact. The client wants to access the resource but hasn't paid.
//     `mppx.session()` returns `{ status: 402 }` with a challenge containing
//     the payment terms (method: "tempo", intent: "session", amount per token,
//     currency, recipient, etc.). The server returns this as a 402 response
//     with `WWW-Authenticate: Payment <challenge>`.
//
//   Phase 2 — POST, Authorization contains "open" credential:
//     The client has opened an on-chain payment channel and is sending the
//     signed transaction + initial voucher. `mppx.stream()` verifies the
//     credential, broadcasts the channel-open tx, and returns a managed
//     result. `withReceipt()` detects this and returns the management
//     response automatically (the generator is never invoked).
//
//   Phase 3 — GET, Authorization contains "voucher" credential:
//     The channel is open. The client is requesting the SSE stream with a
//     valid voucher. `withReceipt(generator)` wraps the async generator
//     in an SSE response and starts streaming.
//
//   Phase 4 — POST, Authorization contains "voucher" credential (mid-stream):
//     While the SSE stream from Phase 3 is still running, the client sends
//     incremental voucher updates (triggered by `payment-need-voucher` events).
//     These POSTs are intercepted by the SSE transport and update the
//     channel's `highestVoucherAmount` in shared storage. `withReceipt()`
//     returns the management response without invoking the generator.
//
export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  // Simple health check endpoint (no payment required).
  if (url.pathname === '/api/health') return Response.json({ status: 'ok' })

  if (url.pathname === '/api/chat') {
    const prompt = url.searchParams.get('prompt') ?? 'Hello!'

    console.log(`[server] ${request.method} /api/chat`)

    // `mppx.session()` creates a streaming payment handler configured with
    // the per-token price and unit type. It returns a function that processes
    // the incoming request through the payment flow.
    //
    // `amount` — The price per charge unit (per token in this case).
    //   This becomes the `tickCost` in the SSE metering loop.
    //
    // `unitType` — A label for what's being charged ("token"). Appears in
    //   receipts so the client knows what the units represent.
    //
    // The returned function accepts a Request and returns a result object
    // describing what phase we're in and how to respond.
    const result = await mppx.session({
      amount: pricePerToken,
      unitType: 'token',
    })(request)

    // Phase 1: No valid credential → 402 Payment Required.
    // `result.challenge` is a Response object with the WWW-Authenticate header
    // containing the base64url-encoded challenge parameters.
    if (result.status === 402) return result.challenge

    // Phases 2–4: `withReceipt` handles everything.
    //
    // If the request is a management action (channel open, mid-stream voucher
    // POST, or close), `withReceipt` short-circuits and returns the managed
    // response — the generator is never invoked.
    //
    // If the request is a content request (GET with voucher), `withReceipt`
    // wraps the async generator in an SSE response. The generator receives
    // a `stream` controller with a `charge()` method.
    //
    // The generator pattern: yield content tokens, call `stream.charge()`
    // before each one. `charge()` does the following:
    //
    //   1. Atomically deducts `tickCost` (the per-token price) from the
    //      channel's available balance in shared storage.
    //
    //   2. If sufficient balance: returns immediately, and we yield the
    //      next token as an SSE `event: message`.
    //
    //   3. If insufficient balance: emits a `event: payment-need-voucher` SSE
    //      event with the required cumulative amount, then blocks (polls
    //      or waits on storage updates) until the client sends a new
    //      voucher via POST. Once the client's POST updates storage,
    //      `charge()` retries the deduction and succeeds.
    //
    // After all tokens are yielded, the transport automatically appends a
    // final `event: payment-receipt` SSE event with the settlement details.
    //
    return result.withReceipt(async function* (stream) {
      for await (const token of generateTokens(prompt)) {
        try {
          // `stream.charge()` — Charge the client for one token.
          //
          // This is the core of the pay-per-token model. Each call:
          //   - Deducts `pricePerToken` from the channel's available balance
          //   - If the client's voucher doesn't cover this charge, a
          //     `payment-need-voucher` SSE event is emitted and the call blocks
          //     until a new voucher arrives via POST
          //   - Only returns once payment is confirmed, ensuring the server
          //     never gives away content for free
          await stream.charge()
        } catch {
          // Client disconnected or abort signal fired — stop streaming.
          break
        }
        // Yield the token — this becomes an `event: message\ndata: <token>`
        // in the SSE stream. The client's async iterator surfaces this as
        // the next value in `for await (const token of tokens)`.
        yield token
      }
    })
  }

  // Return null for unrecognized paths (framework can handle 404).
  return null
}

// Mock Token Generator

//
// Simulates an LLM-style token stream. In a real application, this would be
// replaced with an actual LLM API call (e.g., OpenAI, Anthropic) that yields
// tokens as they're generated.
//
// Each yielded string is one "token" — the unit of billing. The server
// charges `pricePerToken` pathUSD for each one via `stream.charge()`.
//
// The random delay (20-80ms) simulates realistic LLM token generation
// latency, which varies based on model size, load, and token complexity.
async function* generateTokens(prompt: string): AsyncGenerator<string> {
  const words = [
    'The',
    ' question',
    ' you',
    ' asked',
    '--"',
    prompt,
    '"--is',
    ' a',
    ' fascinating',
    ' one.',
    '\n\n',
    'In',
    ' short,',
    ' the',
    ' answer',
    ' depends',
    ' on',
    ' context.',
    ' Let',
    ' me',
    ' explain',
    ' with',
    ' a',
    ' few',
    ' key',
    ' points:',
    '\n\n',
    '1.',
    ' First,',
    ' consider',
    ' the',
    ' underlying',
    ' assumptions.',
    '\n',
    '2.',
    ' Then,',
    ' evaluate',
    ' the',
    ' available',
    ' evidence.',
    '\n',
    '3.',
    ' Finally,',
    ' draw',
    ' your',
    ' own',
    ' conclusions.',
    '\n\n',
    'Hope',
    ' that',
    ' helps!',
  ]
  for (const word of words) {
    yield word
    await new Promise((r) => setTimeout(r, 20 + Math.random() * 60))
  }
}

// Server Startup

//
// Log the server's recipient address (where settled funds go) and fund it
// via the testnet faucet. The server account needs a small amount of native
// tokens (for gas) to settle channels on-chain, though in production the
// `feePayer` option can be used to have the protocol cover gas.
console.log(`Server recipient: ${account.address}`)
await Actions.faucet.fundSync(client, { account, timeout: 30_000 })
console.log('Server account funded')
