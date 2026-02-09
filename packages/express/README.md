# @mpp/express

Express middleware for [mpay](https://github.com/wevm/mpay) — HTTP 402 payment gating.

## Install

```bash
pnpm add @mpp/express mpay express
```

## Usage

```ts
import express from 'express'
import { paymentRequired } from '@mpp/express'
import { Mpay, tempo } from 'mpay/server'

const mpay = Mpay.create({
  methods: [tempo.charge({ currency, recipient, feePayer, testnet: true })],
})

const app = express()

app.get(
  '/api/fortune',
  paymentRequired(mpay, 'charge', { amount: '1' }),
  (req, res) => {
    res.json({ fortune: 'Hello!' })
  },
)
```
