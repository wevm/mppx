---
name: mpay-cloudflare
description: mpay integration with Cloudflare Workers. Use when building paid APIs with Cloudflare Workers or when asked about mpay + Cloudflare patterns.
---

# mpay + Cloudflare Workers

Cloudflare Workers use Web Standard `Request`/`Response`, making integration clean.

## Examples

### Explicit

```ts
import { Expires, Mpay, tempo } from 'mpay/server'

export interface Env {
  MPAY_SECRET_KEY: string
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const mpay = Mpay.create({
      method: tempo({ chainId: 42431, rpcUrl: 'https://rpc.tempo.xyz' }),
      realm: 'api.example.com',
      secretKey: env.MPAY_SECRET_KEY,
    })

    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' })
    }

    if (url.pathname === '/fortune') {
      const result = await mpay.charge({
        request: {
          amount: '1000000',
          currency: '0x...',
          recipient: '0x...',
          expires: Expires.minutes(5),
        },
      })(request)

      if (result.status === 402) return result.challenge

      return result.withReceipt(Response.json({ fortune: 'You will be rich' }))
    }

    return new Response('Not Found', { status: 404 })
  },
}
```

### Composed

```ts
import { Expires, Mpay, tempo } from 'mpay/server'

export interface Env {
  MPAY_SECRET_KEY: string
}

function createPaid(mpay: ReturnType<typeof Mpay.create>) {
  return function paid(
    config: { amount: string; currency: string; recipient: string },
    handler: (request: Request) => Promise<Response> | Response,
  ): (request: Request) => Promise<Response> {
    return async (request) => {
      const result = await mpay.charge({
        request: { ...config, expires: Expires.minutes(5) },
      })(request)

      if (result.status === 402) return result.challenge

      const response = await handler(request)
      return result.withReceipt(response)
    }
  }
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const mpay = Mpay.create({
      method: tempo({ chainId: 42431, rpcUrl: 'https://rpc.tempo.xyz' }),
      realm: 'api.example.com',
      secretKey: env.MPAY_SECRET_KEY,
    })

    const paid = createPaid(mpay)
    const url = new URL(request.url)

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' })
    }

    if (url.pathname === '/fortune') {
      return paid(
        { amount: '1000000', currency: '0x...', recipient: '0x...' },
        () => Response.json({ fortune: 'You will be rich' }),
      )(request)
    }

    return new Response('Not Found', { status: 404 })
  },
}
```

## With Hono on Workers

For routing, combine with Hono:

```ts
import { Hono } from 'hono'
import { Expires, Mpay, tempo } from 'mpay/server'

type Bindings = {
  MPAY_SECRET_KEY: string
}

const app = new Hono<{ Bindings: Bindings }>()

app.get('/health', (c) => c.json({ status: 'ok' }))

app.get('/fortune', async (c) => {
  const mpay = Mpay.create({
    method: tempo({ chainId: 42431, rpcUrl: 'https://rpc.tempo.xyz' }),
    realm: 'api.example.com',
    secretKey: c.env.MPAY_SECRET_KEY,
  })

  const result = await mpay.charge({
    request: {
      amount: '1000000',
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
