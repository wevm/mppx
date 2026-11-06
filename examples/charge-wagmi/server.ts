// Payment-gated photo API on Cloudflare Workers, for the Wagmi page in src/.
//
// `/api/photo` costs 0.01 per request. The page pays from the connected
// wallet (passkey or MetaMask), which broadcasts the payment itself.
//
// Charge replay protection lives in Durable Objects through
// `Store.durableObject()`, so a payment can't be spent twice on two isolates.
import { Mppx, Store, tempo } from 'mppx/server'
import { createClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Chain } from 'viem/tempo'

// The Durable Object class that stores used payments, bound as `MPPX_STORE`.
export class MppxStore extends Store.DurableObjectStore {}

type Env = {
  /** Durable Object namespace of {@link MppxStore}. */
  MPPX_STORE: Store.durableObject.Namespace
  /** Payee account key: receives payments. */
  MPP_PRIVATE_KEY: string
  /** Secret that binds challenge IDs, so they verify statelessly. */
  MPP_SECRET_KEY: string
  /** Optional Tempo RPC URL, such as a dedicated provider. Defaults to the public RPC. */
  TEMPO_RPC_URL?: string | undefined
}

let mppx: ReturnType<typeof createMppx> | undefined
function createMppx(env: Env) {
  const account = privateKeyToAccount(env.MPP_PRIVATE_KEY as Hex)
  const client = createClient({ chain: Chain.testnet, transport: http(env.TEMPO_RPC_URL) })
  return Mppx.create({
    methods: [
      tempo({
        account,
        chainId: Chain.testnet.id,
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

    // Free
    if (url.pathname === '/api/health') return Response.json({ status: 'ok' })

    // Paid
    if (url.pathname === '/api/photo') {
      mppx ??= createMppx(env)
      const result = await mppx.charge({
        amount: '0.01',
        description: 'Random stock photo',
      })(request)

      if (result.status === 402) return result.challenge

      // A random photo: picsum.photos picks the image for each seed.
      const photoUrl = `https://picsum.photos/seed/${crypto.randomUUID()}/1024/1024`
      return result.withReceipt(Response.json({ url: photoUrl }))
    }

    return new Response('Not found', { status: 404 })
  },
}
