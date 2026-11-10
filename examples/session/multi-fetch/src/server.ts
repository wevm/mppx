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

// `Mppx` is the server-side payment handler that manages challenges, credential
// verification, and receipt generation. `tempo` provides the Tempo-specific
// streaming payment method.
//
// The server runs as a Cloudflare Worker (locally in workerd through
// `pnpm dev`). Channel state lives in Durable Objects through
// `channels()` from `mppx/cloudflare`, so every request and the close see the
// same channel from any isolate. Each channel's object also sends it to the
// settlement queue once enough is unsettled, or once it goes idle, and the
// Worker's `queue()` handler settles it on-chain.
import { ChannelStore, channels, settle } from 'mppx/cloudflare'
import { Mppx, tempo } from 'mppx/server'
import { createClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Chain } from 'viem/tempo'

// The Durable Object class that stores channel state and schedules its
// settlement, bound as `MPPX_STORE`.
export class MppxStore extends ChannelStore {}

// Worker bindings and secrets. `pnpm keygen` writes the secrets to
// `.dev.vars` for local development; deploy them with `wrangler secret put`.
type Env = {
  /** Durable Object namespace of {@link MppxStore}. */
  MPPX_STORE: channels.Namespace
  /** Queue the channel objects send channels to settle to. */
  MPPX_SETTLEMENT_QUEUE: ChannelStore.Queue
  /**
   * Server account key. This account serves two purposes:
   *   1. It's the `recipient` — the address that receives payment channel funds
   *   2. It signs the on-chain close/settle transaction when the channel closes
   */
  MPP_PRIVATE_KEY: string
  /** Secret that binds challenge IDs, so they verify statelessly. */
  MPP_SECRET_KEY: string
  /** Optional Tempo RPC URL, such as a dedicated provider. Defaults to the public RPC. */
  TEMPO_RPC_URL?: string | undefined
}

// pathUSD testnet TIP-20 token address on Tempo Moderato.
// Must match what the client uses — both sides need to agree on the token.
const currency = '0x20c0000000000000000000000000000000000000' as const

// The viem client (created per Worker isolate in `createMppx` below) MUST
// have an `account` attached. This is critical because
// the server needs to sign on-chain transactions when closing/settling
// payment channels. Without an account, `closeOnChain()` in the stream
// handler will fail, and the server won't be able to claim its funds.
//
// `pollingInterval: 1_000` makes block polling faster for demo responsiveness.

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
//   - Tracks channel state in a store (here, Durable Objects)
//
// Configuration:
//   - `currency`: The TIP-20 token address to accept payment in
//   - `recipient`: The server's address that receives funds on settlement
//   - `getClient: () => client`: Returns an account-bearing viem client.
//     The server needs this to:
//       (a) Read on-chain channel state (deposit, settled amounts)
//       (b) Broadcast the client's open transaction
//       (c) Submit close/settle transactions to claim funds
//     If you omit the account from the client, channel opens will work (the
//     client's signed tx is broadcast) but closes will silently fail — the
//     server can't sign the settle tx without a key.
//   - `store`: Where channel state lives. Workers isolates share no memory,
//     so a Durable Object store keeps it consistent across requests.
//   - `chainId`: Tempo testnet. Without it the server expects mainnet.
//
// `Mppx.create()` requires a secret key so challenge IDs can be verified
// statelessly.
//
// Workers allow no I/O outside a request, so the handler is built lazily
// from `env` on the first request and reused afterwards.
let mppx: ReturnType<typeof createMppx> | undefined
function createMppx(env: Env) {
  const { account, client } = connect(env)
  return Mppx.create({
    secretKey: env.MPP_SECRET_KEY,
    methods: [
      tempo.session({
        account,
        chainId: Chain.testnet.id,
        currency,
        feePayer: true,
        getClient: () => client,
        // `store` for channel state, and `resolveChannelId` to resume a payer's open channel.
        // `resolveChannelId` needs the payer identity a HEAD bootstrap proves, so enable it.
        bootstrap: true,
        ...channels(env.MPPX_STORE),
      }),
    ],
  })
}

/** The server account and an account-bearing client for Tempo testnet. */
function connect(env: Env) {
  const account = privateKeyToAccount(env.MPP_PRIVATE_KEY as Hex)
  const client = createClient({
    account,
    chain: Chain.testnet,
    pollingInterval: 1_000,
    transport: http(env.TEMPO_RPC_URL),
  })
  return { account, client }
}

// Request handler

//
// The Worker's `fetch` is a standard Request → Response handler.
//
// The page to scrape is a path segment (`/api/scrape/<encoded url>`), not a
// query parameter: the client posts its close voucher back to the last URL it
// fetched, and mppx treats a POST with a query string as a paid content request.
export default {
  // Settles the channels the channel objects sent to the settlement queue.
  async queue(batch: settle.Batch, env: Env): Promise<void> {
    const { account, client } = connect(env)
    await settle(batch, { account, getClient: () => client, store: channels(env.MPPX_STORE).store })
  },

  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Health check endpoint — no payment required.
    if (url.pathname === '/api/health') return Response.json({ status: 'ok' })

    const match = url.pathname.match(/^\/api\/scrape(?:\/(.+))?$/)
    if (!match) return new Response('Not found', { status: 404 })
    const pageUrl = match[1] ? decodeURIComponent(match[1]) : 'https://example.com'
    mppx ??= createMppx(env)

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

    // Open, voucher, top-up and close POSTs are management requests: they get
    // the receipt alone. mppx bills any other request, including a POST with a
    // query string or body, as content, so it falls through and gets content.
    const managed = await managementResponse(result)
    if (managed) return managed

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
  },
}

// Simulated scraping function. In a real app, this would fetch and parse
// the actual URL. The point is that this work only happens AFTER payment
// is verified — the server never does expensive work for free.
function scrapePage(url: string): string {
  return `<h1>${url}</h1><p>Scraped content from ${url}</p>`
}

/** Returns mppx's management response, or `null` for a request billed as content. */
async function managementResponse(result: { withReceipt: () => Response | Promise<Response> }) {
  try {
    return await result.withReceipt()
  } catch (error) {
    if (Mppx.isMissingReceiptResponseError(error)) return null
    throw error
  }
}
