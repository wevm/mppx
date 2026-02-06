---
name: mpay-express
description: mpay integration with Express framework. Use when building paid APIs with Express or when asked about mpay + Express patterns.
---

# mpay + Express

Express uses mutation-based `(req, res, next)` pattern. Requires converting to Web `Request`.

## Examples

### Explicit

```ts
import express from 'express'
import { Expires, Mpay, tempo } from 'mpay/server'

const app = express()

const mpay = Mpay.create({
  method: tempo.charge(),
  realm: 'api.example.com',
  secretKey: process.env.MPAY_SECRET_KEY!,
})

function toRequest(req: express.Request): Request {
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`
  return new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
  })
}

app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.get('/fortune', async (req, res) => {
  const result = await mpay.charge({
    request: {
      amount: '1',
      currency: '0x...',
      recipient: '0x...',
      expires: Expires.minutes(5),
    },
  })(toRequest(req))

  if (result.status === 402) {
    const challenge = result.challenge as Response
    res.status(402)
    for (const [key, value] of challenge.headers) res.setHeader(key, value)
    res.send(await challenge.text())
    return
  }

  const wrapped = result.withReceipt(Response.json({ fortune: 'You will be rich' }))
  res.setHeader('Payment-Receipt', wrapped.headers.get('Payment-Receipt')!)
  res.json({ fortune: 'You will be rich' })
})

app.listen(3000)
```

### Composed

```ts
import express, { type RequestHandler } from 'express'
import { Expires, Mpay, tempo } from 'mpay/server'

const app = express()

const mpay = Mpay.create({
  method: tempo.charge(),
  realm: 'api.example.com',
  secretKey: process.env.MPAY_SECRET_KEY!,
})

function toRequest(req: express.Request): Request {
  const url = `${req.protocol}://${req.get('host')}${req.originalUrl}`
  return new Request(url, {
    method: req.method,
    headers: req.headers as Record<string, string>,
  })
}

function paid(config: {
  amount: string
  currency: string
  recipient: string
}): RequestHandler {
  return async (req, res, next) => {
    const result = await mpay.charge({
      request: { ...config, expires: Expires.minutes(5) },
    })(toRequest(req))

    if (result.status === 402) {
      const challenge = result.challenge as Response
      res.status(402)
      for (const [key, value] of challenge.headers) res.setHeader(key, value)
      res.send(await challenge.text())
      return
    }

    const originalJson = res.json.bind(res)
    res.json = (body) => {
      const wrapped = result.withReceipt(Response.json(body))
      res.setHeader('Payment-Receipt', wrapped.headers.get('Payment-Receipt')!)
      return originalJson(body)
    }

    next()
  }
}

app.get('/health', (req, res) => res.json({ status: 'ok' }))

app.get(
  '/fortune',
  paid({ amount: '1', currency: '0x...', recipient: '0x...' }),
  (req, res) => res.json({ fortune: 'You will be rich' }),
)

app.listen(3000)
```
