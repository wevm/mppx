# mppx

TypeScript SDK for the [**Machine Payments Protocol**](https://machinepayments.dev)

[![npm](https://img.shields.io/npm/v/mppx.svg)](https://www.npmjs.com/package/mppx)
[![License](https://img.shields.io/npm/l/mppx.svg)](LICENSE)

## Documentation

Full documentation, API reference, and guides are available at **[machinepayments.dev/sdk/typescript](https://machinepayments.dev/sdk/typescript)**.

## Install

```bash
npm i mppx
```

## Quick Start

### Server

```ts
import { Mppx, tempo } from 'mppx/server'

const mppx = Mppx.create({
  methods: [
    tempo({
      currency: '0x20c0000000000000000000000000000000000000',
      recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00',
    }),
  ],
})

export async function handler(request: Request) {
  const response = await mppx.charge({ amount: '1' })(request)

  if (response.status === 402) return response.challenge

  return response.withReceipt(Response.json({ data: '...' }))
}
```

### Client

```ts
import { privateKeyToAccount } from 'viem/accounts'
import { Mppx, tempo } from 'mppx/client'

Mppx.create({
  methods: [tempo({ account: privateKeyToAccount('0x...') })],
})

// Global fetch now handles 402 automatically
const res = await fetch('https://api.example.com/resource')
```

## Examples

| Example | Description |
|---------|-------------|
| [charge](./examples/charge/) | Payment-gated photo generation API |
| [session/multi-fetch](./examples/session/multi-fetch/) | Multiple paid requests over a single payment channel |
| [session/sse](./examples/session/sse/) | Pay-per-token LLM streaming with SSE |

```bash
npx gitpick wevm/mppx/examples/charge
```

## CLI

`mppx` includes a basic CLI for making HTTP requests with automatic payment handling.

```bash
# create account - stored in keychain, autofunded on testnet
mppx account create

# make request - automatic payment handling, curl-like api
mppx example.com
```

You can also install globally to use the `mppx` CLI from anywhere:

```bash
npm i -g mppx
```

## Payments Proxy

`mppx` exports a `Proxy` server handler so that you can create or define a 402-protected payments proxy for any API.

```ts
import { openai, stripe, Proxy } from 'mppx/proxy'
import { Mppx, tempo } from 'mppx/server'

const mppx = Mppx.create({ methods: [tempo()] })

const proxy = Proxy.create({
  services: [
    openai({
      apiKey: 'sk-...',
      routes: {
        'POST /v1/chat/completions': mppx.charge({ amount: '0.05' }),
        'POST /v1/completions': mppx.stream({ amount: '0.0001' }),
        'GET /v1/models': mppx.free(),
      },
    }),
    stripe({
      apiKey: 'sk-...',
      routes: {
        'POST /v1/charges': mppx.charge({ amount: '0.01' }),
        'GET /v1/customers/:id': mppx.free(),
      },
    }),
  ],
})

createServer(proxy.listener) // Node.js
Bun.serve(proxy) // Bun
Deno.serve(proxy.fetch) // Deno
app.use(proxy.listener) // Express
app.all('*', (c) => proxy.fetch(c.req.raw)) // Hono
app.all('*', (c) => proxy.fetch(c.request)) // Elysia
export const GET = proxy.fetch // Next.js
export const POST = proxy.fetch // Next.js
```

This exposes the following routes:

| Route | Pricing |
|-------|---------|
| `POST /openai/v1/chat/completions` | charge **$0.005** |
| `POST /openai/v1/completions` | stream **$0.0001 per token** |
| `GET /openai/v1/models` | free |
| `POST /stripe/v1/charges` | charge **$0.01** |
| `GET /stripe/v1/customers/:id` | free |

## Protocol

Built on the ["Payment" HTTP Authentication Scheme](https://datatracker.ietf.org/doc/draft-ietf-httpauth-payment/). See [payment-auth-spec](https://github.com/tempoxyz/payment-auth-spec) for the full specification.

## License

MIT
