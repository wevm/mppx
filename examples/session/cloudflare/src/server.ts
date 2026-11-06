// Pay-per-token SSE streaming on Cloudflare Workers — Example
//
// The same flow as `examples/session/sse`, deployed as a Worker:
//
//   GET  /api/chat/<prompt>  (no auth)     → 402 + WWW-Authenticate challenge
//   POST /api/chat/<prompt>  (open cred)   → broadcast the channel open
//   GET  /api/chat/<prompt>  (voucher)     → SSE stream, charging per token
//   POST /api/chat/<prompt>  (voucher)     → mid-stream vouchers
//   POST /api/chat/<prompt>  (close cred)  → settle the channel on-chain
//
// These requests can land on different isolates (even different data
// centers), so channel state can't live in memory. `Store.durableObject()`
// keeps each channel in its own Durable Object: every read-modify-write of a
// channel is atomic, and the SSE stream's `stream.charge()` sees the vouchers
// that other requests accept.
import { Mppx, Store, tempo } from 'mppx/server'
import { createClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Chain } from 'viem/tempo'

// The Durable Object class that stores channel state. It's bound as
// `MPPX_STORE` in wrangler.jsonc.
export class MppxStore extends Store.DurableObjectStore {}

type Env = {
  /** Durable Object namespace of {@link MppxStore}. */
  MPPX_STORE: Store.durableObject.Namespace
  /** Payee account key: receives payments and pays settlement gas. */
  MPP_PRIVATE_KEY: string
  /** Secret that binds challenge IDs. */
  MPP_SECRET_KEY: string
  /** Optional Tempo RPC URL, such as a dedicated provider. Defaults to the public RPC. */
  TEMPO_RPC_URL?: string | undefined
}

// pathUSD on Tempo testnet (6 decimals). For mainnet, use `Chain.mainnet` and
// a mainnet stablecoin such as USDC.
const currency = '0x20c0000000000000000000000000000000000000' as const
const pricePerToken = '0.000075'
const suggestedDeposit = '1'

// Build the payment handler once per isolate, from the Worker's bindings.
let mppx: ReturnType<typeof createMppx> | undefined
function createMppx(env: Env) {
  const account = privateKeyToAccount(env.MPP_PRIVATE_KEY as Hex)
  const client = createClient({ account, chain: Chain.testnet, transport: http(env.TEMPO_RPC_URL) })
  return Mppx.create({
    secretKey: env.MPP_SECRET_KEY,
    methods: [
      tempo.session({
        account,
        currency,
        getClient: () => client,
        store: Store.durableObject(env.MPPX_STORE),
        chainId: Chain.testnet.id,
        sse: true,
      }),
    ],
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/health') return Response.json({ status: 'ok' })
    // The prompt is a path segment, not a query parameter: the client posts
    // vouchers back to this URL, and mppx bills a POST with a query string as content.
    const [, route, prompt = 'Hello!'] = url.pathname.match(/^\/api\/(chat)(?:\/(.+))?$/) ?? []
    if (!route) return new Response('Not found', { status: 404 })

    mppx ??= createMppx(env)
    const result = await mppx.session({
      amount: pricePerToken,
      suggestedDeposit,
      unitType: 'token',
    })(request)

    // No valid credential: ask for payment.
    if (result.status === 402) return result.challenge
    // Open, voucher and close POSTs are management requests: no content.
    if (request.method === 'POST') return result.withReceipt()

    // Stream tokens, charging one `pricePerToken` before each. When the
    // channel runs low, `stream.charge()` emits `payment-need-voucher` and
    // waits until the client's voucher POST lands in the Durable Object.
    return result.withReceipt(async function* (stream) {
      for await (const token of generateTokens(decodeURIComponent(prompt))) {
        await stream.charge()
        yield token
      }
    })
  },
}

// Mock LLM. Replace with a real model's token stream.
async function* generateTokens(prompt: string): AsyncGenerator<string> {
  const text = `The question you asked--"${prompt}"--is a fascinating one.\n\nIn short, the answer depends on context. Consider the underlying assumptions, evaluate the available evidence, then draw your own conclusions.\n\nHope that helps!`
  for (const word of text.split(/(?=\s)/)) {
    yield word
    await new Promise((resolve) => setTimeout(resolve, 20 + Math.random() * 60))
  }
}
