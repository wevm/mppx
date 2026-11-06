// Tempo subscription on Cloudflare Workers — Example
//
// A news app sells daily access for 0.10 pathUSD. The first paid request
// activates a subscription: the server returns a Tempo access key in the
// challenge and the client signs a `keyAuthorization` scoped to it. Later
// requests reuse the active subscription without another charge.
//
// Subscriptions live in Durable Objects through `Store.durableObject()`, so
// activation and reuse can land on any isolate.
import { Receipt } from 'mppx'
import { Mppx, Store, tempo } from 'mppx/server'
import { Subscription } from 'mppx/tempo'
import { createClient, type Hex, http } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Chain } from 'viem/tempo'

// The Durable Object class that stores subscriptions, bound as `MPPX_STORE`.
export class MppxStore extends Store.DurableObjectStore {}

type Env = {
  /** Durable Object namespace of {@link MppxStore}. */
  MPPX_STORE: Store.durableObject.Namespace
  /** Payee account key: receives subscription payments and sponsors their fees. */
  MPP_PRIVATE_KEY: string
  /** Secret that binds challenge IDs. */
  MPP_SECRET_KEY: string
  /** Optional Tempo RPC URL, such as a dedicated provider. Defaults to the public RPC. */
  TEMPO_RPC_URL?: string | undefined
}

// pathUSD on Tempo testnet (6 decimals).
const currency = '0x20c0000000000000000000000000000000000000' as const
const planId = 'monthly'
const pricePerPeriod = '0.10'
const periodCount = '1'
const periodUnit = 'day'
const subscriptionDurationMs = 30 * 24 * 60 * 60 * 1_000

function subscriptionKey(source: { address: string; chainId: number }) {
  return `news:eip155:${source.chainId}:${source.address.toLowerCase()}:${planId}`
}

// Every isolate must offer the same subscription terms, or a payer who
// activated on one isolate would not match a challenge from another and would
// pay to activate again. The first request fixes the expiry in the shared store;
// once it passes, the next request starts a new term.
async function planExpires(store: Store.AtomicStore): Promise<string> {
  const now = Date.now()
  const proposed = new Date(Math.ceil((now + subscriptionDurationMs) / 1_000) * 1_000).toISOString()
  return store.update('news:plan:expires', (current) =>
    typeof current === 'string' && Date.parse(current) > now
      ? { op: 'noop', result: current }
      : { op: 'set', value: proposed, result: proposed },
  )
}

let app: (ReturnType<typeof createApp> & { expires: string }) | undefined
function createApp(env: Env, store: Store.AtomicStore, subscriptionExpires: string) {
  const account = privateKeyToAccount(env.MPP_PRIVATE_KEY as Hex)
  const client = createClient({ chain: Chain.testnet, transport: http(env.TEMPO_RPC_URL) })

  const mppx = Mppx.create({
    secretKey: env.MPP_SECRET_KEY,
    methods: [
      tempo.subscription({
        amount: pricePerPeriod,
        chainId: Chain.testnet.id,
        currency,
        getClient: () => client,
        periodCount,
        periodUnit,
        // The payee also sponsors activation and renewal fees.
        account,
        feePayer: true,
        // Access is keyed from the payer signature instead of a user-controlled header.
        requireCredential: true,
        resolve: async ({ source }) => {
          if (!source) return null
          return { key: subscriptionKey(source) }
        },
        store,
        subscriptionExpires,
        hooks: {
          activated: async ({ subscription }) => {
            console.log(`[subscription] activated ${subscription.subscriptionId}`)
          },
          renewed: async ({ periodIndex, subscription }) => {
            console.log(
              `[subscription] renewed ${subscription.subscriptionId} period=${periodIndex}`,
            )
          },
        },
      }),
    ],
  })
  return { mppx, subscriptions: Subscription.fromStore(store) }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)
    if (url.pathname === '/api/health') return Response.json({ status: 'ok' })

    const store = Store.durableObject(env.MPPX_STORE)
    const expires = await planExpires(store)
    if (app?.expires !== expires) app = { ...createApp(env, store, expires), expires }
    const { mppx, subscriptions } = app

    if (url.pathname === '/api/subscription') {
      const result = await mppx.tempo.subscription({
        description: 'News app daily subscription status',
      })(request)
      if (result.status === 402) return result.challenge

      // The verified credential receipt identifies the payer-bound subscription.
      const receipt = Receipt.fromResponse(result.withReceipt(new Response(null)))
      if (!receipt.subscriptionId) {
        return Response.json({ error: 'missing subscription receipt' }, { status: 500 })
      }
      return result.withReceipt(Response.json(await subscriptions.get(receipt.subscriptionId)))
    }

    if (url.pathname === '/api/article') {
      const result = await mppx.tempo.subscription({
        description: 'News app daily subscription',
      })(request)
      if (result.status === 402) return result.challenge

      return result.withReceipt(
        Response.json({
          article: 'Tempo subscriptions let a news app sell recurring access.',
          plan: planId,
        }),
      )
    }

    return new Response('Not found', { status: 404 })
  },
}
