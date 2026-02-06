---
name: mpay-elysia
description: mpay integration with Elysia framework. Use when building paid APIs with Elysia or when asked about mpay + Elysia patterns.
---

# mpay + Elysia

Elysia uses a hook-based lifecycle with `beforeHandle` and `afterHandle`.

## Examples

### Explicit

```ts
import { Elysia } from 'elysia'
import { Expires, Mpay, tempo } from 'mpay/server'

const app = new Elysia()

const mpay = Mpay.create({
  method: tempo.charge(),
  realm: 'api.example.com',
  secretKey: process.env.MPAY_SECRET_KEY!,
})

app.get('/health', () => ({ status: 'ok' }))

app.get('/fortune', async ({ request }) => {
  const result = await mpay.charge({
    request: {
      amount: '1',
      currency: '0x...',
      recipient: '0x...',
      expires: Expires.minutes(5),
    },
  })(request)

  if (result.status === 402) return result.challenge

  return result.withReceipt(Response.json({ fortune: 'You will be rich' }))
})

app.listen(3000)
```

### Composed

```ts
import { Elysia } from 'elysia'
import { Expires, Mpay, tempo } from 'mpay/server'

const mpay = Mpay.create({
  method: tempo.charge(),
  realm: 'api.example.com',
  secretKey: process.env.MPAY_SECRET_KEY!,
})

function paid(config: { amount: string; currency: string; recipient: string }) {
  return new Elysia({ name: 'mpay-paid' }).onBeforeHandle(async ({ request }) => {
    const result = await mpay.charge({
      request: { ...config, expires: Expires.minutes(5) },
    })(request)

    if (result.status === 402) return result.challenge
  })
}

const app = new Elysia()
  .get('/health', () => ({ status: 'ok' }))
  .use(paid({ amount: '1', currency: '0x...', recipient: '0x...' }))
  .get('/fortune', () => ({ fortune: 'You will be rich' }))
  .listen(3000)
```

> **Note:** Elysia auto-serializes return values. To add `Payment-Receipt` headers, return a `Response` object from the handler.
