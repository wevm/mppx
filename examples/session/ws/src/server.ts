// WebSocket Streaming Payment Server — Example

//
// This example demonstrates the server side of a metered WebSocket session
// using mppx's Tempo `session` method plus the experimental websocket helper.
//
// The flow is intentionally pragmatic and transport-specific:
//
//   1. Client sends a normal HTTP GET to `/ws/chat`
//      → server responds `402 Payment Required` with `WWW-Authenticate`
//
//   2. Client opens a WebSocket to `/ws/chat`
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
import type * as node_http from 'node:http'
import type * as node_net from 'node:net'

// `Mppx` is the server-side payment handler. `tempo` provides the Tempo
// payment method plus the websocket helper used for this demo.
import { Mppx, Store, tempo } from 'mppx/server'
import { createClient, http } from 'viem'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { tempoModerato } from 'viem/chains'
import { Actions } from 'viem/tempo'
import { WebSocketServer } from 'ws'

// Server Account Setup

//
// Generate a fresh account for the demo server. This account is the payee —
// the recipient that receives settled channel funds after the stream ends.
const account = privateKeyToAccount(generatePrivateKey())

// pathUSD — TIP-20 token on Tempo testnet (Moderato).
// All payment amounts in this example are denominated in pathUSD with 6 decimals.
const currency = '0x20c0000000000000000000000000000000000000' as const

// Price charged per streamed token. Every application token requires one
// successful `stream.charge()` call before it is yielded to the client.
const pricePerToken = '0.000075'

// `Mppx.create()` requires a secret key so challenge IDs can be verified
// statelessly. The example ships with a default demo key so `pnpm dev` works
// out of the box, but still allows override via `MPP_SECRET_KEY`.
const secretKey = process.env.MPP_SECRET_KEY ?? 'mppx-demo-websocket-secret'

// Viem Client

//
// The server-side viem client carries the payee account because the Tempo
// session method needs signing capabilities for settlement and close flows.
const client = createClient({
  account,
  chain: tempoModerato,
  pollingInterval: 1_000,
  transport: http(),
})

// Shared Channel Store

//
// The websocket stream and the credential verification path must see the same
// channel state. `Store.memory()` is enough for a local demo because both the
// route handler and websocket helper run in the same process.
const store = Store.memory()

// Mppx Server Instance

//
// `tempo.session()` still owns the actual payment semantics here:
// challenge issuance, channel open verification, voucher verification, and
// cooperative close. The websocket helper is only responsible for transport.
const mppx = Mppx.create({
  methods: [
    tempo.session({
      account,
      currency,
      getClient: () => client,
      store,
      testnet: true,
    }),
  ],
  secretKey,
})

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
// `tempo.Ws.serve()` does not perform the HTTP upgrade itself. We use `ws`
// only for the low-level upgrade mechanics, then hand the accepted socket to
// mppx's Tempo websocket helper for payment-aware streaming.
const wsServer = new WebSocketServer({ noServer: true })
wsServer.on('connection', (socket, req) => {
  const url = new URL(req.url ?? '/ws/chat', `ws://${req.headers.host ?? 'localhost:5173'}`)
  const prompt = url.searchParams.get('prompt') ?? 'Tell me something interesting'

  // `tempo.Ws.serve()` bridges websocket control frames to the existing
  // Tempo session lifecycle. When it receives an in-band authorization frame,
  // it verifies it through `route`. Once paid, it runs this generator and
  // emits application chunks interleaved with payment control frames.
  void tempo.Ws.serve({
    socket,
    store,
    url,
    route,
    generate: async function* (stream) {
      for await (const token of generateTokens(prompt)) {
        await stream.charge()
        yield token
      }
    },
  })
})

// Fund the server account so it can submit settlement transactions during the
// demo. In production this would be a long-lived account with managed funds.
console.log(`Server recipient: ${account.address}`)
await Actions.faucet.fundSync(client, { account, timeout: 30_000 })
console.log('Server account funded')

// HTTP Request Handler

//
// This handler only needs to cover the HTTP 402 probe endpoint. For actual
// content streaming, the client must use the websocket upgrade path.
export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  if (url.pathname === '/api/health') return Response.json({ status: 'ok' })

  if (url.pathname === '/ws/chat') {
    // The initial client request arrives here without credentials and receives
    // a 402 challenge. Later, management-style HTTP requests could also be
    // verified here if you choose to mix transports.
    const result = await route(request)
    if (result.status === 402) return result.challenge

    // Once a route has already been paid over HTTP, return a simple message so
    // it is obvious that WebSocket is the intended content path for this demo.
    return result.withReceipt(
      new Response(
        'Use the websocket endpoint for streaming. HTTP is only used for the 402 probe.',
      ),
    )
  }

  return null
}

// Vite/Node Upgrade Bridge

//
// Vite gives us the raw Node HTTP server. We intercept upgrade requests for
// `/ws/chat`, let `ws` turn them into WebSocket connections, and then hand the
// socket to the `connection` handler above.
export function handleUpgrade(
  req: node_http.IncomingMessage,
  socket: node_net.Socket,
  head: Buffer,
) {
  if (req.url?.startsWith('/ws/chat') !== true) return

  wsServer.handleUpgrade(req, socket, head, (websocket) => {
    wsServer.emit('connection', websocket, req)
  })
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
