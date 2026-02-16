import { Mppx, stripe } from 'mppx/server'
import Stripe from 'stripe'

const secretKey = process.env.VITE_STRIPE_SECRET_KEY!
const stripeClient = new Stripe(secretKey)

//
const mppx = Mppx.create({
  methods: [
    stripe.charge({
      client: stripeClient,
      // Stripe Business Network profile ID.
      networkId: 'internal',
      // Ensure only card is supported.
      paymentMethodTypes: ['card'],
    }),
  ],
})

// Handles creating an SPT and charging a customer.
// In production examples, this would be a DIFFERENT server than
// the one that handles the HTTP 402 flow.
export async function handler(request: Request): Promise<Response | null> {
  const url = new URL(request.url)

  if (url.pathname === '/api/create-spt') {
    const { paymentMethod, amount, currency, expiresAt, networkId, metadata } =
      (await request.json()) as {
        paymentMethod: string
        amount: string
        currency: string
        expiresAt: number
        networkId?: string
        metadata?: Record<string, string>
      }

    if (metadata?.externalId) {
      return Response.json(
        { error: 'metadata.externalId is reserved; use credential externalId instead' },
        { status: 400 },
      )
    }

    const body = new URLSearchParams({
      payment_method: paymentMethod,
      'usage_limits[currency]': currency,
      'usage_limits[max_amount]': amount,
      'usage_limits[expires_at]': expiresAt.toString(),
    })
    if (networkId) body.set('seller_details[network_id]', networkId)
    if (metadata) {
      for (const [key, value] of Object.entries(metadata)) {
        body.set(`metadata[${key}]`, value)
      }
    }

    // Test-only endpoint; production SPT flow uses the agent-side issued_tokens API.
    const createSpt = async (bodyParams: URLSearchParams) =>
      fetch('https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${secretKey}:`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: bodyParams,
      })

    let response = await createSpt(body)
    if (!response.ok) {
      const error = (await response.json()) as { error: { message: string } }
      if ((metadata || networkId) && error.error.message.includes('Received unknown parameter')) {
        const fallbackBody = new URLSearchParams({
          payment_method: paymentMethod,
          'usage_limits[currency]': currency,
          'usage_limits[max_amount]': amount,
          'usage_limits[expires_at]': expiresAt.toString(),
        })
        response = await createSpt(fallbackBody)
      } else {
        return Response.json({ error: error.error.message }, { status: 500 })
      }
    }

    if (!response.ok) {
      const error = (await response.json()) as { error: { message: string } }
      return Response.json({ error: error.error.message }, { status: 500 })
    }

    const { id: spt } = (await response.json()) as { id: string }
    return Response.json({ spt })
  }

  if (url.pathname === '/api/fortune') {
    const result = await mppx.charge({
      amount: '1',
      currency: 'usd',
      decimals: 2,
    })(request)

    if (result.status === 402) return result.challenge

    const fortune = fortunes[Math.floor(Math.random() * fortunes.length)]!
    return result.withReceipt(Response.json({ fortune }))
  }

  return null
}

const fortunes = [
  'A beautiful, smart, and loving person will come into your life.',
  'A dubious friend may be an enemy in camouflage.',
  'A faithful friend is a strong defense.',
  'A fresh start will put you on your way.',
  'A golden egg of opportunity falls into your lap this month.',
  'A good time to finish up old tasks.',
  'A hunch is creativity trying to tell you something.',
  'A lifetime of happiness lies ahead of you.',
  'A light heart carries you through all the hard times.',
  'A new perspective will come with the new year.',
]
