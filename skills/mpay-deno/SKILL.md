---
name: mpay-deno
description: mpay integration with Deno. Use when building paid APIs with Deno or when asked about mpay + Deno patterns.
---

# mpay + Deno

Deno uses native Web Standard `Request`/`Response`, making it straightforward.

## Examples

### Explicit

```ts
import { Expires, Mpay, tempo } from 'npm:mpay/server'

const mpay = Mpay.create({
  method: tempo.charge(),
  realm: 'api.example.com',
  secretKey: Deno.env.get('MPAY_SECRET_KEY')!,
})

Deno.serve(async (req: Request) => {
  const url = new URL(req.url)

  if (url.pathname === '/health') {
    return Response.json({ status: 'ok' })
  }

  if (url.pathname === '/fortune') {
    const result = await mpay.charge({
      request: {
        amount: '1',
        currency: '0x...',
        recipient: '0x...',
        expires: Expires.minutes(5),
      },
    })(req)

    if (result.status === 402) return result.challenge

    return result.withReceipt(Response.json({ fortune: 'You will be rich' }))
  }

  return new Response('Not Found', { status: 404 })
})
```

### Composed

```ts
import { Expires, Mpay, tempo } from 'npm:mpay/server'

const mpay = Mpay.create({
  method: tempo.charge(),
  realm: 'api.example.com',
  secretKey: Deno.env.get('MPAY_SECRET_KEY')!,
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

Deno.serve(
  paid({ amount: '1', currency: '0x...', recipient: '0x...' }, () =>
    Response.json({ fortune: 'You will be rich' }),
  ),
)
```
