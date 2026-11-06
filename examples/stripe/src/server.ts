// Stripe × mppx on Cloudflare Workers — Example
//
// The Worker serves the API; Vite serves the browser page (index.html) as
// static assets. `/api/fortune` charges $1.00 through a Stripe SPT, which the
// server verifies by creating a Stripe PaymentIntent.
import { Mppx, stripe } from 'mppx/server'
import Stripe from 'stripe'

type Env = {
  /** Secret that binds challenge IDs. */
  MPP_SECRET_KEY: string
  /** Stripe test secret key (sk_test_...). */
  STRIPE_SECRET_KEY: string
  /** Stripe test publishable key (pk_test_...), for the HTML payment page. */
  STRIPE_PUBLIC_KEY: string
}

let mppx: ReturnType<typeof createMppx> | undefined
function createMppx(env: Env) {
  return Mppx.create({
    secretKey: env.MPP_SECRET_KEY,
    methods: [
      stripe.charge({
        client: new Stripe(env.STRIPE_SECRET_KEY),
        html: {
          createTokenUrl: '/api/create-spt',
          publishableKey: env.STRIPE_PUBLIC_KEY,
        },
        // Stripe Business Network profile ID.
        networkId: 'internal',
        // Ensure only card is supported.
        paymentMethodTypes: ['card'],
      }),
    ],
  })
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url)

    // Handles creating an SPT and charging a customer.
    // In production examples, this would be a DIFFERENT server than
    // the one that handles the HTTP 402 flow.
    if (url.pathname === '/api/create-spt') return createSpt(request, env.STRIPE_SECRET_KEY)

    if (url.pathname === '/api/fortune') {
      mppx ??= createMppx(env)
      const result = await mppx.charge({
        amount: '1',
        currency: 'usd',
        decimals: 2,
      })(request)

      if (result.status === 402) return result.challenge

      const fortune = fortunes[Math.floor(Math.random() * fortunes.length)]!
      return result.withReceipt(Response.json({ fortune }))
    }

    return new Response('Not found', { status: 404 })
  },
}

async function createSpt(request: Request, secretKey: string): Promise<Response> {
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
  const create = async (bodyParams: URLSearchParams) =>
    fetch('https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens', {
      method: 'POST',
      headers: {
        Authorization: `Basic ${btoa(`${secretKey}:`)}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: bodyParams,
    })

  let response = await create(body)
  if (!response.ok) {
    const error = (await response.json()) as { error: { message: string } }
    if ((metadata || networkId) && error.error.message.includes('Received unknown parameter')) {
      const fallbackBody = new URLSearchParams({
        payment_method: paymentMethod,
        'usage_limits[currency]': currency,
        'usage_limits[max_amount]': amount,
        'usage_limits[expires_at]': expiresAt.toString(),
      })
      response = await create(fallbackBody)
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
