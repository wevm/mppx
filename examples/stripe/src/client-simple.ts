// Same Stripe charge example, but using Mpay.create to handle the
// 402 flow automatically. Polyfills globalThis.fetch so plain fetch()
// calls negotiate payment transparently.
//
// Hits the same server as client.ts — see src/server.ts.

import { Mpay, stripe } from 'mpay/client'

Mpay.create({
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
      paymentMethod: 'pm_card_visa',
    }),
  ],
})

// fetch() now handles 402 → credential → retry automatically
const { fortune } = await fetch('/api/fortune').then((r) => r.json())
console.log(fortune)
