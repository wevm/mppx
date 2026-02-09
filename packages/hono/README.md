# @mpp/hono

Hono middleware for [mpay](https://github.com/wevm/mpay) — HTTP 402 payment gating.

## Install

```bash
pnpm add @mpp/hono mpay hono
```

## Usage

```ts
import { Hono } from 'hono'
import { paymentRequired } from '@mpp/hono'
import { Mpay, tempo } from 'mpay/server'

const mpay = Mpay.create({
  methods: [tempo.charge({ currency, recipient, feePayer, testnet: true })],
})

const app = new Hono()

app.get(
  '/api/fortune',
  paymentRequired(mpay, 'charge', { amount: '1' }),
  (c) => {
    const withReceipt = c.get('withReceipt')
    return withReceipt(c.json({ fortune: 'Hello!' }))
  },
)
```
