---
name: mpay-bun
description: mpay integration with Bun.serve. Use when building paid APIs with Bun or when asked about mpay + Bun patterns.
---

# mpay + Bun

Bun.serve uses native Web Standard `Request`/`Response`, making it straightforward.

## Examples

### Explicit

```ts
import { Expires, Mpay, tempo } from 'mpay/server'

const mpay = Mpay.create({
  method: tempo({ chainId: 42431, rpcUrl: 'https://rpc.tempo.xyz' }),
  realm: 'api.example.com',
  secretKey: process.env.MPAY_SECRET_KEY!,
})

Bun.serve({
  async fetch(req: Request) {
    const url = new URL(req.url)

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
      })(req)

      if (result.status === 402) return result.challenge

      return result.withReceipt(Response.json({ fortune: 'You will be rich' }))
    }

    return new Response('Not Found', { status: 404 })
  },
  port: 3000,
})
```

### Composed

```ts
import { Expires, Mpay, tempo } from 'mpay/server'

const mpay = Mpay.create({
  method: tempo({ chainId: 42431, rpcUrl: 'https://rpc.tempo.xyz' }),
  realm: 'api.example.com',
  secretKey: process.env.MPAY_SECRET_KEY!,
})

function paid(
  config: { amount: string; currency: string; recipient: string },
  handler: (req: Request) => Promise<Response> | Response,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const result = await mpay.charge({
      request: { ...config, expires: Expires.minutes(5) },
    })(req)

    if (result.status === 402) return result.challenge

    const response = await handler(req)
    return result.withReceipt(response)
  }
}

const fortuneHandler = paid(
  { amount: '1000000', currency: '0x...', recipient: '0x...' },
  () => Response.json({ fortune: 'You will be rich' }),
)

Bun.serve({
  async fetch(req: Request) {
    const url = new URL(req.url)

    if (url.pathname === '/health') {
      return Response.json({ status: 'ok' })
    }

    if (url.pathname === '/fortune') {
      return fortuneHandler(req)
    }

    return new Response('Not Found', { status: 404 })
  },
  port: 3000,
})
```
