---
name: mpay-hono
description: mpay integration with Hono framework. Use when building paid APIs with Hono or when asked about mpay + Hono patterns.
---

# mpay + Hono

Hono uses the Web Standard `Request`/`Response` pattern, making it the cleanest integration.

## Examples

### Explicit

```ts
import { Hono } from 'hono'
import { Expires, Mpay, tempo } from 'mpay/server'

const app = new Hono()

const mpay = Mpay.create({
  method: tempo.charge(),
  realm: 'api.example.com',
  secretKey: process.env.MPAY_SECRET_KEY!,
})

app.get('/health', (c) => c.json({ status: 'ok' }))

app.get('/fortune', async (c) => {
  const result = await mpay.charge({
    request: {
      amount: '1',
      currency: '0x...',
      recipient: '0x...',
      expires: Expires.minutes(5),
    },
  })(c.req.raw)

  if (result.status === 402) return result.challenge

  return result.withReceipt(c.json({ fortune: 'You will be rich' }))
})

export default app
```

### Composed

```ts
import { Hono } from 'hono'
import type { MiddlewareHandler } from 'hono'
import { Expires, Mpay, tempo } from 'mpay/server'

const app = new Hono()

const mpay = Mpay.create({
  method: tempo.charge(),
  realm: 'api.example.com',
  secretKey: process.env.MPAY_SECRET_KEY!,
})

function paid(config: {
  amount: string
  currency: string
  recipient: string
}): MiddlewareHandler {
  return async (c, next) => {
    const result = await mpay.charge({
      request: { ...config, expires: Expires.minutes(5) },
    })(c.req.raw)

    if (result.status === 402) return result.challenge

    await next()
    return result.withReceipt(c.res)
  }
}

app.get('/health', (c) => c.json({ status: 'ok' }))

app.get(
  '/fortune',
  paid({ amount: '1', currency: '0x...', recipient: '0x...' }),
  (c) => c.json({ fortune: 'You will be rich' }),
)

export default app
```
