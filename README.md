# mpay

TypeScript SDK for the [Machine Payments Protocol](https://machinepayments.dev).

[![npm](https://img.shields.io/npm/v/mpay.svg)](https://www.npmjs.com/package/mpay)
[![License](https://img.shields.io/npm/l/mpay.svg)](LICENSE)

## Documentation

Full documentation, API reference, and guides are available at **[machinepayments.dev/sdk/typescript](https://machinepayments.dev/sdk/typescript)**.

## Install

```bash
npm i mpay
```

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

### Client

```ts
import { privateKeyToAccount } from 'viem/accounts'
import { Mpay, tempo } from 'mpay/client'

Mpay.create({
  methods: [tempo.charge({ account: privateKeyToAccount('0x...') })],
})

// Global fetch now handles 402 automatically
const res = await fetch('https://api.example.com/resource')
```

## Examples

| Example | Description |
|---------|-------------|
| [basic](./examples/basic/) | Bun server with pay-per-request fortune API |
| [stream](./examples/stream/) | Streaming payment channels with per-token LLM metering |

```bash
npx gitpick wevm/mpay/examples/basic
```

## Protocol

Built on the ["Payment" HTTP Authentication Scheme](https://datatracker.ietf.org/doc/draft-ietf-httpauth-payment/). See [payment-auth-spec](https://github.com/tempoxyz/payment-auth-spec) for the full specification.

## License

MIT
