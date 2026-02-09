# @mpp/nextjs

Next.js App Router adapter for [mpay](https://github.com/wevm/mpay) — HTTP 402 payment gating.

## Install

```bash
pnpm add @mpp/nextjs mpay
```

## Usage

```ts
// app/api/fortune/route.ts
import { PaidRoute } from '@mpp/nextjs'
import { Mpay, tempo } from 'mpay/server'

const mpay = Mpay.create({
  methods: [tempo.charge({ currency, recipient, feePayer, testnet: true })],
})

export const GET = PaidRoute(
  mpay,
  'charge',
  { amount: '1' },
  async (request, { withReceipt }) => {
    return withReceipt(Response.json({ fortune: 'Hello!' }))
  },
)
```
