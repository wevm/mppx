# mpay

TypeScript SDK for [Web Payment Auth](https://datatracker.ietf.org/doc/draft-ietf-httpauth-payment/) — the IETF standard for HTTP authentication-based payments.

[![npm](https://img.shields.io/npm/v/mpay.svg)](https://www.npmjs.com/package/mpay)
[![License](https://img.shields.io/npm/l/mpay.svg)](LICENSE)

## Features

- **Full 402 flow** — Server issues challenges, client creates credentials, server verifies and returns receipts
- **Pluggable methods** — Ship with Tempo support, bring your own payment methods
- **Multiple intents** — `charge`, `stream`, and custom intents with validated schemas
- **Fetch polyfill** — Automatic 402 handling via `globalThis.fetch` or a standalone wrapper
- **MCP support** — First-class integration with `@modelcontextprotocol/sdk` for both client and server
- **Node.js compatible** — Works with `http.createServer` via `Mpay.toNodeListener`
- **Type-safe** — Full TypeScript inference from intent schemas to credential payloads

## Contents

- [Install](#install)
- [Quick Start](#quick-start)
  - [Server](#server)
  - [Client](#client)
- [MCP Integration](#mcp-integration)
- [Streaming Payments](#streaming-payments)
- [API Reference](#api-reference)
  - [Core](#core)
  - [Server](#server-1)
  - [Client](#client-1)
- [Examples](#examples)
- [Development](#development)
- [License](#license)

## Install

```bash
npm i mpay
```

**Peer dependencies** (install as needed):

| Package | Required for |
|---------|-------------|
| `viem` | Tempo payment method |
| `zod` | Custom intent schemas |
| `@modelcontextprotocol/sdk` | MCP integration |

## Quick Start

### Server

```ts
import { Mpay, tempo } from 'mpay/server'

const mpay = Mpay.create({
  intents: [
    tempo.charge({
      currency: '0x20c0000000000000000000000000000000000001',
      recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00',
    }),
  ],
})

export async function handler(request: Request) {
  const response = await mpay.charge({ amount: '1' })(request)

  if (response.status === 402) return response.challenge

  return response.withReceipt(Response.json({ data: '...' }))
}
```

#### Node.js HTTP

Use `Mpay.toNodeListener` for Node.js `http.createServer` compatibility:

```ts
import * as http from 'node:http'
import { Mpay } from 'mpay/server'

http.createServer(async (req, res) => {
  const result = await Mpay.toNodeListener(
    mpay.charge({ amount: '1' }))(req, res)

  if (result.status === 402) return

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ data: '...' }))
}).listen(3000)
```

### Client

#### Polyfill (default)

The easiest approach — `Mpay.create()` polyfills `globalThis.fetch`:

```ts
import { privateKeyToAccount } from 'viem/accounts'
import { Mpay, tempo } from 'mpay/client'

Mpay.create({
  methods: [tempo.charge({ account: privateKeyToAccount('0x...') })],
})

// Global fetch now handles 402 automatically
const res = await fetch('https://api.example.com/resource')

// Restore original fetch when done
Mpay.restore()
```

#### Fetch wrapper

If you prefer not to polyfill globals, set `polyfill: false`:

```ts
import { Mpay, tempo } from 'mpay/client'

const mpay = Mpay.create({
  polyfill: false,
  methods: [tempo.charge({ account: privateKeyToAccount('0x...') })],
})

const res = await mpay.fetch('https://api.example.com/resource')
```

#### Manual

For full control, create credentials yourself:

```ts
import { Challenge } from 'mpay'
import { Mpay, tempo } from 'mpay/client'

const mpay = Mpay.create({
  polyfill: false,
  methods: [tempo.charge({ account: privateKeyToAccount('0x...') })],
})

const res = await fetch('https://api.example.com/resource')
if (res.status !== 402) return

const credential = await mpay.createCredential(res)

const res2 = await fetch('https://api.example.com/resource', {
  headers: { 'Authorization': credential },
})
```

## MCP Integration

### MCP Server

```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp'
import { Mpay, Transport, tempo } from 'mpay/server'

const mpay = Mpay.create({
  intents: [
    tempo.charge({
      currency: '0x20c0000000000000000000000000000000000001',
      recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00',
    }),
  ],
  transport: Transport.mcpSdk(),
})

const server = new McpServer({ name: 'my-server', version: '1.0.0' })

server.registerTool('premium_tool', { description: '...' }, async (extra) => {
  const result = await mpay.charge({ amount: '1' })(extra)

  if (result.status === 402) throw result.challenge

  return result.withReceipt({ content: [{ type: 'text', text: 'Tool executed' }] })
})
```

### MCP Client

```ts
import { Client } from '@modelcontextprotocol/sdk/client'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio'
import { McpClient, tempo } from 'mpay/mcp-sdk/client'
import { privateKeyToAccount } from 'viem/accounts'

const client = new Client({ name: 'my-client', version: '1.0.0' })
await client.connect(new StdioClientTransport({ command: 'mcp-server' }))

const mcp = McpClient.wrap(client, {
  methods: [tempo.charge({ account: privateKeyToAccount('0x...') })],
})

const result = await mcp.callTool({ name: 'premium_tool', arguments: {} })

console.log(result.content) // Tool result
console.log(result.receipt) // Payment receipt
```

## Streaming Payments

The `stream` intent enables pay-as-you-go payments using cumulative vouchers over a payment channel, ideal for metered services like per-token LLM billing.

```ts
// Server
import { Mpay, tempo } from 'mpay/server'

const mpay = Mpay.create({
  intents: [
    tempo.stream({
      currency: '0x20c0000000000000000000000000000000000001',
      recipient: '0x742d35Cc...',
      escrowContract: '0xescrow...',
    }),
  ],
})
```

```ts
// Client
import { Mpay, tempo } from 'mpay/client'

const mpay = Mpay.create({
  methods: [tempo.stream({ account: privateKeyToAccount('0x...') })],
})
```

See the [stream example](./examples/stream/) for a full working demo.

## API Reference

### Core

Import from `mpay`:

| Export | Description |
|--------|------------|
| `Challenge` | Create, serialize, deserialize, and verify payment challenges |
| `Credential` | Create, serialize, and deserialize payment credentials |
| `Receipt` | Create, serialize, and deserialize payment receipts |
| `Intent` | Define method-agnostic intent schemas |
| `MethodIntent` | Extend intents with method-specific details |
| `PaymentRequest` | Create and serialize intent-specific request data |
| `BodyDigest` | Compute SHA-256 body digests for request binding |
| `z` | Re-exported Zod with payment-specific refinements (`z.amount()`, `z.hash()`, `z.signature()`, `z.datetime()`) |

#### `Challenge.from`

```ts
import { Challenge } from 'mpay'

const challenge = Challenge.from({
  id: 'challenge-id',
  realm: 'api.example.com',
  method: 'tempo',
  intent: 'charge',
  request: { amount: '1000000', currency: '0x...', recipient: '0x...' },
})
```

#### `Challenge.serialize` / `Challenge.deserialize`

```ts
const header = Challenge.serialize(challenge)
// => 'Payment id="...", realm="...", method="...", intent="...", request="<base64url>"'

const parsed = Challenge.deserialize(header)
```

#### `Challenge.verify`

Verify that a challenge ID matches the expected HMAC:

```ts
const isValid = Challenge.verify(challenge, { secretKey: 'my-secret' })
```

#### `Credential.from` / `Credential.serialize` / `Credential.deserialize`

```ts
import { Credential } from 'mpay'

const credential = Credential.from({
  challenge,
  source: 'did:pkh:eip155:42431:0x...',
  payload: { signature: '0x...', type: 'transaction' },
})

const header = Credential.serialize(credential)   // => 'Payment <base64url>'
const parsed = Credential.deserialize(header)
```

#### `Receipt.from` / `Receipt.serialize` / `Receipt.deserialize`

```ts
import { Receipt } from 'mpay'

const receipt = Receipt.from({
  status: 'success',
  method: 'tempo',
  timestamp: new Date().toISOString(),
  reference: '0x...',
})

const header = Receipt.serialize(receipt)
const parsed = Receipt.deserialize(header)
```

### Server

Import from `mpay/server`:

| Export | Description |
|--------|------------|
| `Mpay` | Server-side payment handler |
| `tempo` | Tempo payment method (`.charge()`, `.stream()`) |
| `Transport` | Transport adapters (`.http()`, `.mcp()`, `.mcpSdk()`) |

#### `Mpay.create`

```ts
import { Mpay, tempo } from 'mpay/server'

const mpay = Mpay.create({
  intents: [
    tempo.charge({
      currency: '0x20c0000000000000000000000000000000000001',
      recipient: '0x742d35Cc...',
    }),
  ],
  realm: 'api.example.com',         // default: "MPP Payment"
  secretKey: process.env.SECRET_KEY, // recommended for production
})
```

#### `Mpay.toNodeListener`

Wraps a payment handler for `http.createServer`. Automatically writes 402 responses and sets `Payment-Receipt` headers on success.

### Client

Import from `mpay/client`:

| Export | Description |
|--------|------------|
| `Mpay` | Client-side payment handler |
| `tempo` | Tempo payment method (`.charge()`, `.stream()`) |

#### `Mpay.create`

```ts
import { Mpay, tempo } from 'mpay/client'
import { privateKeyToAccount } from 'viem/accounts'

const mpay = Mpay.create({
  methods: [tempo.charge({ account: privateKeyToAccount('0x...') })],
  polyfill: true, // default — patches globalThis.fetch
})
```

#### `Mpay.restore`

Restores the original `globalThis.fetch` after polyfilling:

```ts
Mpay.restore()
```

### Entrypoints

| Path | Description |
|------|------------|
| `mpay` | Core types: `Challenge`, `Credential`, `Receipt`, `Intent`, `MethodIntent`, `z` |
| `mpay/server` | Server-side: `Mpay`, `tempo`, `Transport` |
| `mpay/client` | Client-side: `Mpay`, `tempo` |
| `mpay/tempo` | Tempo method intents and stream utilities |
| `mpay/mcp-sdk/client` | MCP SDK client wrapper: `McpClient`, `tempo` |
| `mpay/mcp-sdk/server` | MCP SDK server transport |

## Examples

| Example | Description |
|---------|-------------|
| [basic](./examples/basic/) | Bun server with pay-per-request fortune API |
| [stream](./examples/stream/) | Streaming payment channels with per-token LLM metering |

Run examples from the repo root:

```bash
pnpm install
pnpm dev:example
```

Or install directly into your project:

```bash
npx gitpick wevm/mpay/examples/basic
```

## Protocol

```
Client                                              Server
  │                                                   │
  │  GET /resource                                    │
  ├──────────────────────────────────────────────────>│
  │                                                   │
  │                 402 + WWW-Authenticate: Payment   │
  │<──────────────────────────────────────────────────┤
  │                                                   │
  │  GET /resource                                    │
  │  Authorization: Payment <credential>              │
  ├──────────────────────────────────────────────────>│
  │                                                   │
  │                 200 OK                             │
  │                 Payment-Receipt: <receipt>         │
  │<──────────────────────────────────────────────────┤
```

Built on the ["Payment" HTTP Authentication Scheme](https://datatracker.ietf.org/doc/draft-ietf-httpauth-payment/). See [payment-auth-spec](https://github.com/tempoxyz/payment-auth-spec) for the full specification.

## Development

```bash
pnpm build        # Build with zile
pnpm check        # Lint and format with biome
pnpm check:types  # TypeScript type checking
pnpm test         # Run tests with vitest
```

## License

MIT
