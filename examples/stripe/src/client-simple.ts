// Example of a simple client that creates an SPT and retries with the credential.
// This is useful if you know the payment method ahead of time, and don't need to collect it from the user.

import { Mppx, stripe } from 'mppx/client'

Mppx.create({
  methods: [
    stripe({
      createSpt: async (params) => {
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
