import { Receipt } from 'mppx'
import { Mppx, Store, tempo } from 'mppx/server'
import { Subscription } from 'mppx/tempo'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'

const currency = '0x20c0000000000000000000000000000000000000' as const
const planId = 'monthly'
const pricePerPeriod = '0.10'
const periodCount = '1'
const periodUnit = 'day'
const subscriptionDurationMs = 30 * 24 * 60 * 60 * 1_000
const subscriptionExpiresAtMs = Math.ceil((Date.now() + subscriptionDurationMs) / 1_000) * 1_000
const subscriptionExpires = new Date(subscriptionExpiresAtMs).toISOString()

const account = privateKeyToAccount(generatePrivateKey())
const store = Store.memory()
const subscriptions = Subscription.fromStore(store)

function subscriptionKey(source: { address: string; chainId: number }) {
  return `news:eip155:${source.chainId}:${source.address.toLowerCase()}:${planId}`
}

const mppx = Mppx.create({
  methods: [
    tempo.subscription({
      amount: pricePerPeriod,
      chainId: 4217,
      currency,
      periodCount,
      periodUnit,
      recipient: account.address,
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
          console.log(`[subscription] renewed ${subscription.subscriptionId} period=${periodIndex}`)
        },
      },
    }),
  ],
})

export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  if (url.pathname === '/api/health') return Response.json({ status: 'ok' })

  if (url.pathname === '/api/subscription') {
    const result = await mppx.tempo.subscription({
      description: 'News app daily subscription status',
    })(request)
    if (result.status === 402) return result.challenge

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

  return null
}
