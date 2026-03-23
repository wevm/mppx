---
name: mppx
description: TypeScript SDK for the Payment HTTP Authentication Scheme—handles 402 Payment Required flows with stablecoin and Stripe payment methods. Use when integrating mppx into a client or server application.
---

# mppx

TypeScript SDK for the "Payment" HTTP Authentication Scheme. Handles the full 402 Payment Required flow: challenge, credential, receipt.

## Architecture

Two layers:

- **Core** (`mppx`): `Challenge`, `Credential`, `Receipt`, `Method`, `Mppx` primitives
- **Client** (`mppx/client`): Payment-aware `fetch` that auto-handles 402 responses
- **Server** (`mppx/server`): Middleware that issues challenges and verifies credentials

## Client setup

```ts
import { Mppx, tempo } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'

const account = privateKeyToAccount('0x...')

// Creates a payment-aware fetch and polyfills globalThis.fetch
const mppx = Mppx.create({
  methods: [tempo({ account })],
})

// Automatically handles 402 → credential → retry
const res = await mppx.fetch('https://api.example.com/resource')
```

## Server setup

```ts
import { Mppx, tempo } from 'mppx/server'

const mppx = Mppx.create({
  methods: [
    tempo({
      currency: '0x...', // TIP-20 token address
      recipient: '0x...', // payment recipient
    }),
  ],
  secretKey: process.env.MPP_SECRET_KEY,
})

// Use in a route handler
async function handler(request: Request): Promise<Response> {
  const result = await mppx.charge({
    amount: '1.00',
    description: 'API call',
  })(request)

  if (result.status === 402) return result.challenge
  return result.withReceipt(Response.json({ data: '...' }))
}
```

## Payment methods

- **`tempo`**: Stablecoin payments on Tempo (TIP-20 tokens). Supports `charge` (one-time) and `session` (streaming) intents.
- **`stripe`**: Stripe payments. Supports `charge` intent.

Client methods require an `account` (viem account). Server methods require a `currency` and `recipient`.

## Framework middleware

Available at `mppx/hono`, `mppx/express`, `mppx/nextjs`, `mppx/elysia`.

## Key patterns

- **402 flow**: Server returns `402` with `WWW-Authenticate: Payment ...` → Client creates credential → Client retries with `Authorization: Payment ...` → Server returns `200` with `Payment-Receipt: ...`
- **`result.status === 402`**: Always check. Return `result.challenge` for unpaid requests.
- **`result.withReceipt(response)`**: Wraps a `Response` with the `Payment-Receipt` header.
- **`Mppx.create()`**: Entry point for both client and server. Accepts `methods` array.
- **`mppx.compose()`**: Server-side. Combines multiple payment method handlers into a single route (for example, offer both Tempo and Stripe).

## Exports

| Path | Purpose |
|---|---|
| `mppx` | Core primitives (`Challenge`, `Credential`, `Receipt`, `Method`) |
| `mppx/client` | Client-side (`Mppx`, `tempo`, `stripe`, `session`, `Transport`) |
| `mppx/server` | Server-side (`Mppx`, `tempo`, `stripe`, `Transport`, `Store`) |
| `mppx/hono` | Hono middleware |
| `mppx/express` | Express middleware |
| `mppx/nextjs` | Next.js middleware |
| `mppx/elysia` | Elysia middleware |
| `mppx/proxy` | Proxy server handler |
| `mppx/stripe` | Stripe payment method internals |
| `mppx/tempo` | Tempo payment method internals |

## Environment variables

- `MPP_SECRET_KEY`: Server secret for HMAC-bound challenge IDs (required on server)
- `MPP_REALM`: Server realm (auto-detected from `VERCEL_URL`, `RAILWAY_PUBLIC_DOMAIN`, etc.)

## References

- Spec: https://github.com/tempoxyz/payment-auth-spec
- Docs: https://mpp.dev
