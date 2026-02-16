// Example of a simple client that creates an SPT and retries with the credential.
// This is useful if you know the payment method ahead of time, and don't need to collect it from the user.

import { loadStripe } from '@stripe/stripe-js'
import { Mppx, stripe } from 'mppx/client'

const stripeJs = (await loadStripe(import.meta.env.VITE_STRIPE_PUBLIC_KEY as string))!

Mppx.create({
  methods: [
    stripe({
      client: stripeJs,
      createToken: async (params) => {
        const res = await fetch('/api/create-spt', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(params),
        })
        if (!res.ok) throw new Error('Failed to create SPT')
        return (await res.json()).spt
      },
      // Stripe test payment method.
      paymentMethod: 'pm_card_visa',
    }),
  ],
})

// fetch() now handles 402 → credential → retry automatically
const { fortune } = await fetch('/api/fortune').then((r) => r.json())
console.log(fortune)
