// WebSocket Streaming Payment Server — Example

//
// This example demonstrates the server side of a metered WebSocket session
// using mppx's Tempo `session` method plus the experimental websocket helper.
// The server is a Cloudflare Worker (locally in workerd through `pnpm dev`):
// the Worker accepts the upgrade with a `WebSocketPair` and hands its server
// end to `mppx.session.serveWebSocket()`.
//
// The flow is intentionally pragmatic and transport-specific:
//
//   1. Client sends a normal HTTP GET to `/ws/chat/<prompt>`
//      → server responds `402 Payment Required` with `WWW-Authenticate`
//
//   2. Client opens a WebSocket to the same URL
//      → first socket frame contains the same signed `Payment` credential
//
//   3. Server verifies that credential by routing it back through the normal
//      Tempo `session()` verification path
//
//   4. Server streams application data over the socket, charging per token
//      and sending `payment-need-voucher` control frames whenever it needs
//      more cumulative voucher coverage
//
//   5. Client responds with signed voucher updates over the same socket and
//      eventually sends a final `close` credential to settle the channel
//

// `Mppx` is the server-side payment handler. `tempo` provides the Tempo
// payment method plus the websocket helper used for this demo.
import { Mppx, Store, tempo } from 'mppx/server'
import { createClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Chain } from 'viem/tempo'

// Shared Channel Store

//
// The websocket stream and the credential verification path must see the same
// channel state. Workers isolates share no memory, so channel state lives in
// Durable Objects: this class, bound as `MPPX_STORE`.
export class MppxStore extends Store.DurableObjectStore {}

// Worker bindings and secrets. `pnpm keygen` writes the secrets to
// `.dev.vars` for local development; deploy them with `wrangler secret put`.
type Env = {
  /** Durable Object namespace of {@link MppxStore}. */
  MPPX_STORE: Store.durableObject.Namespace
  /** Payee account key: receives settled channel funds and pays settlement gas. */
  MPP_PRIVATE_KEY: string
  /** Secret that binds challenge IDs, so they verify statelessly. */
  MPP_SECRET_KEY: string
  /** Optional Tempo RPC URL, such as a dedicated provider. Defaults to the public RPC. */
  TEMPO_RPC_URL?: string | undefined
}

// The Workers runtime's WebSocket pair: two connected sockets, one returned to
// the client in the 101 response, one kept by the Worker.
declare const WebSocketPair: new () => { 0: WebSocket; 1: WebSocket & { accept(): void } }

// pathUSD — TIP-20 token on Tempo testnet (Moderato).
// All payment amounts in this example are denominated in pathUSD with 6 decimals.
const currency = '0x20c0000000000000000000000000000000000000' as const

// Price charged per streamed token. Every application token requires one
// successful `stream.charge()` call before it is yielded to the client.
const pricePerToken = '0.000075'

// Mppx Server Instance

//
// `tempo.session()` still owns the actual payment semantics here:
// challenge issuance, channel open verification, voucher verification, and
// cooperative close. The websocket helper is only responsible for transport.
//
// The server-side viem client carries the payee account because the Tempo
// session method needs signing capabilities for settlement and close flows.
//
// Workers allow no I/O outside a request, so the handler is built lazily from
// `env` on the first request and reused afterwards.
let mppx: ReturnType<typeof createMppx> | undefined
function createMppx(env: Env) {
  const account = privateKeyToAccount(env.MPP_PRIVATE_KEY as Hex)
  const client = createClient({
    account,
    chain: Chain.testnet,
    pollingInterval: 1_000,
    transport: http(env.TEMPO_RPC_URL),
  })
  return Mppx.create({
    methods: [
      tempo.session({
        account,
        chainId: Chain.testnet.id,
        currency,
        getClient: () => client,
        store: Store.durableObject(env.MPPX_STORE),
      }),
    ],
    secretKey: env.MPP_SECRET_KEY,
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    if (url.pathname === '/api/health') return Response.json({ status: 'ok' })

    // The prompt is a path segment, not a query parameter: payment frames and
    // the final close are verified as POSTs to this URL, and mppx bills a POST
    // with a query string as a content request.
    const match = url.pathname.match(/^\/ws\/chat(?:\/(.+))?$/)
    if (!match) return new Response('Not found', { status: 404 })
    const prompt = match[1] ? decodeURIComponent(match[1]) : 'Tell me something interesting'

    mppx ??= createMppx(env)

    // This route is the canonical payment entrypoint. It is used twice:
    //
    //   - directly for the initial HTTP 402 probe
    //   - indirectly by the websocket helper, which constructs synthetic POST
    //     requests carrying the websocket-supplied credentials
    const route = mppx.session({
      amount: pricePerToken,
      unitType: 'token',
    })

    // WebSocket Upgrade Handler
    //
    // `mppx.session.serveWebSocket()` does not perform the HTTP upgrade itself.
    // The Worker creates a `WebSocketPair`, accepts the server end and returns
    // the client end in a 101 response.
    if (request.headers.get('Upgrade') === 'websocket') {
      const { 0: client, 1: server } = new WebSocketPair()
      server.accept()

      // `serveWebSocket()` bridges websocket control frames to the existing
      // Tempo session lifecycle and reuses its store and settlement policy. When
      // it receives an in-band authorization frame, it verifies it through
      // `route`. Once paid, it runs this generator and emits application chunks
      // interleaved with payment control frames.
      void mppx.session.serveWebSocket({
        socket: server,
        url,
        route,
        generate: async function* (stream) {
          for await (const token of generateTokens(prompt)) {
            await stream.charge()
            yield token
          }
        },
      })

      return new Response(null, { status: 101, webSocket: client } as ResponseInit)
    }

    // HTTP Request Handler
    //
    // Over HTTP, the client gets its 402 challenge here. A close sent over HTTP
    // after the socket ended is a management POST and gets the receipt alone.
    const result = await route(request)
    if (result.status === 402) return result.challenge
    if (request.method === 'POST') return result.withReceipt()

    // Once a route has already been paid over HTTP, return a simple message so
    // it is obvious that WebSocket is the intended content path for this demo.
    return result.withReceipt(
      new Response(
        'Use the websocket endpoint for streaming. HTTP is only used for the 402 probe.',
      ),
    )
  },
}

// Mock Token Generator

//
// Simulates an LLM-style token stream. Each yielded string is treated as one
// billable unit because the websocket generator calls `stream.charge()` once
// before yielding each token.
async function* generateTokens(prompt: string): AsyncGenerator<string> {
  const words = [
    'The',
    ' question',
    ' you',
    ' asked',
    ' -- "',
    prompt,
    '" --',
    ' is',
    ' a',
    ' good',
    ' one.',
    '\n\n',
    'WebSockets',
    ' let',
    ' us',
    ' keep',
    ' a',
    ' single',
    ' paid',
    ' connection',
    ' open',
    ' while',
    ' vouchers',
    ' move',
    ' in-band.',
    '\n\n',
    'That',
    ' makes',
    ' the',
    ' demo',
    ' feel',
    ' much',
    ' more',
    ' live',
    ' than',
    ' the',
    ' HTTP-only',
    ' loop.',
  ]

  for (const word of words) {
    yield word
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60))
  }
}
