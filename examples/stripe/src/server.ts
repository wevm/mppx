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
      // Publishable key for browser HTML payment form.
      publishableKey: process.env.VITE_STRIPE_PUBLIC_KEY,
      // Secret key for HTML payment page SPT creation.
      secretKey,
    }),
  ],
})

export async function handler(request: Request): Promise<Response | null> {
  const htmlResponse = await mppx.html(request)
  if (htmlResponse) return htmlResponse

  if (new URL(request.url).pathname === '/api/fortune') {
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
