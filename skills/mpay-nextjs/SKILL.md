---
name: mpay-nextjs
description: mpay integration with Next.js App Router. Use when building paid APIs with Next.js or when asked about mpay + Next.js patterns.
---

# mpay + Next.js

Next.js App Router uses Web Standard `Request`/`Response` in route handlers.

## Examples

### Explicit

```ts
// app/api/fortune/route.ts
import { Expires, Mpay, tempo } from 'mpay/server'

const mpay = Mpay.create({
  methods: [tempo.charge()],
  realm: 'api.example.com',
  secretKey: process.env.MPAY_SECRET_KEY!,
})

export async function GET(request: Request) {
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
}
```

```ts
// app/api/health/route.ts
export async function GET() {
  return Response.json({ status: 'ok' })
}
```

### Composed

```ts
// lib/mpay.ts
import { Expires, Mpay, tempo } from 'mpay/server'

export const mpay = Mpay.create({
  methods: [tempo.charge()],
  realm: 'api.example.com',
  secretKey: process.env.MPAY_SECRET_KEY!,
})

export function paid(
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
```

```ts
// app/api/fortune/route.ts
import { paid } from '@/lib/mpay'

export const GET = paid(
  { amount: '1', currency: '0x...', recipient: '0x...' },
  async () => Response.json({ fortune: 'You will be rich' }),
)
```

## Middleware Pattern

```ts
// middleware.ts
import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { mpay } from '@/lib/mpay'

const prices: Record<string, string> = {
  '/api/fortune': '1',
  '/api/premium': '5000000',
}

export async function middleware(request: NextRequest) {
  const price = prices[request.nextUrl.pathname]
  if (!price) return NextResponse.next()

  const result = await mpay.charge({
    request: {
      amount: price,
      currency: '0x...',
      recipient: '0x...',
    },
  })(request)

  if (result.status === 402) return result.challenge

  return NextResponse.next()
}

export const config = {
  matcher: '/api/:path*',
}
```
