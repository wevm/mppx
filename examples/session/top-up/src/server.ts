// Prepaid API with channel top-ups on Cloudflare Workers — Example
//
// A paid search API: every request costs `price`, drawn from the caller's
// payment channel with an off-chain voucher. The server suggests a small
// opening deposit; when it runs out, the client tops up the same channel
// on-chain (no new channel, no new open) and keeps going.
//
// Channel state lives in Durable Objects through `Store.durableObject()`,
// so requests, top-ups and the close can land on any isolate.
import { Mppx, Store, tempo } from 'mppx/server'
import { createClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Chain } from 'viem/tempo'

// The Durable Object class that stores channel state, bound as `MPPX_STORE`.
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
// Each request costs 0.01. The suggested opening deposit covers 3 requests,
// so the client tops up after the third.
const price = '0.01'
const suggestedDeposit = '0.03'

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
      }),
    ],
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/health') return Response.json({ status: 'ok' })
    // The query is a path segment, not a query parameter: open, top-up and close
    // POSTs go to this URL, and mppx bills a POST with a query string as content.
    const [, route, query = ''] = url.pathname.match(/^\/api\/(search)(?:\/(.+))?$/) ?? []
    if (!route) return new Response('Not found', { status: 404 })

    mppx ??= createMppx(env)
    const result = await mppx.session({ amount: price, suggestedDeposit, unitType: 'request' })(
      request,
    )

    // No valid credential, or the channel can't cover this request: the
    // challenge tells the client how much it needs.
    if (result.status === 402) return result.challenge
    // Open, top-up and close POSTs are management requests: no content.
    if (request.method === 'POST') return result.withReceipt()

    const q = decodeURIComponent(query)
    return result.withReceipt(Response.json({ query: q, results: search(q) }))
  },
}

// Mock search backend. The work only runs after payment is verified.
function search(query: string) {
  return [1, 2, 3].map((rank) => ({ rank, title: `Result ${rank} for "${query}"` }))
}
