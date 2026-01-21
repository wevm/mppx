# mpay

HTTP Payment Authentication for TypeScript. Implements the ["Payment" HTTP Authentication Scheme](https://datatracker.ietf.org/doc/draft-ietf-httpauth-payment/) with pluggable payment methods & intents.

```
Client                                              Server
   │                                                   │
   │  (1) fetch('/resource')                           │
   ├──────────────────────────────────────────────────>│
   │                                                   │
   │       (2) challenge = method.intent(request, { ... })
   │             402 + WWW-Authenticate: Payment ...   │
   │<──────────────────────────────────────────────────┤
   │                                                   │
   │  (3) credential = Credential.fromChallenge(challenge)
   │                                                   │
   │  (4) fetch('/resource', Authorization: Payment credential)
   ├──────────────────────────────────────────────────>│
   │                                                   │
   │                    (5) intent.verify(credential)  │
   │                                                   │
   │                    (6) Response.json({ ... })     │
   │                        Payment-Receipt: <receipt> │
   │<──────────────────────────────────────────────────┤
   │                                                   │
```

## Install

```bash
npm i mpay
```

## Quick Start

### Server

```ts
import { Mpay, tempo } from 'mpay/server'

const mpay = Mpay.define({
  method: tempo({
    rpcUrl: 'https://rpc.testnet.tempo.xyz',
  }),
  realm: 'api.example.com',
})

export async function handler(request: Request) {
  const challenge = await mpay.charge(request, {
    amount: '1000000',
    asset: '0x20c0000000000000000000000000000000000001',
    destination: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00',
    expires: '2030-01-20T12:00:00Z',
  })

  // Payment required — send 402 response with challenge
  if (challenge) return challenge

  // Payment verified — return resource
  return Response.json({ data: '...' })
}
```

#### Node.js Compatibility

Intents accept both Fetch `Request` and Node.js `http.IncomingMessage`. 

Intents can write directly to `http.ServerResponse` by passing the response (`res`) as the second argument.

```ts
import * as http from 'node:http'

http.createServer(async (req, res) => {
  const challenge = await mpay.charge(req, res, {
    amount: '1000000',
    asset: '0x20c0000000000000000000000000000000000001',
    destination: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00',
    expires: '2030-01-20T12:00:00Z',
  })
  if (challenge) return challenge

  res.writeHead(200, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify({ data: '...' }))
}).listen(3000)
```

### Client

#### Automatic: Fetch Polyfill

The easiest way to use mpay on the client is to polyfill `fetch` to automatically handle 402 responses:

```ts
import { privateKeyToAccount } from 'viem/accounts'
import { Fetch, tempo } from 'mpay/client'

const account = privateKeyToAccount('0x...')

// Globally polyfill fetch (mutates globalThis.fetch)
Fetch.polyfill({
  methods: [
    tempo({
      account,
      rpcUrl: 'https://rpc.testnet.tempo.xyz',
    }),
  ],
})

// Now fetch handles 402 automatically
const res = await fetch('https://api.example.com/resource')

// Restore original fetch if needed
Fetch.restore()
```

#### Automatic: Fetch Wrapper

If you prefer not to polyfill globals, use `Fetch.from` to get a wrapped fetch function:

```ts
import { privateKeyToAccount } from 'viem/accounts'
import { Fetch, tempo } from 'mpay/client'

const account = privateKeyToAccount('0x...')

const fetch = Fetch.from({
  methods: [
    tempo({
      account,
      rpcUrl: 'https://rpc.testnet.tempo.xyz',
    }),
  ],
})

// Use the wrapped fetch — handles 402 automatically
const res = await fetch('https://api.example.com/resource')
```

#### Manual

For more control, you can manually create credentials:

```ts
import { privateKeyToAccount } from 'viem/accounts'
import { Credential, tempo } from 'mpay/client'
import { Challenge } from 'mpay' // for Challenge.fromHeader

const account = privateKeyToAccount('0x...')

const res = await fetch('https://api.example.com/resource')
if (res.status !== 402) return

const challenge = Challenge.fromHeader(res.headers.get('www-authenticate')!)

const credential = await Credential.fromChallenge(challenge, {
  method: tempo({
    account,
    rpcUrl: 'https://rpc.testnet.tempo.xyz',
  }),
})

// Retry with credential
const res2 = await fetch('https://api.example.com/resource', {
  headers: { 'Authorization': `Payment ${credential}` }
})
```

## API Reference

### Core

#### `Challenge`

A parsed payment challenge from a `WWW-Authenticate` header.

```ts
type Challenge = {
  /** Unique challenge identifier */
  id: string
  /** Payment method (e.g., "tempo", "stripe") */
  method: string
  /** Intent type (e.g., "charge", "authorize") */
  intent: string
  /** Method-specific request data */
  request: unknown
}
```

```ts
import { Challenge } from 'mpay'

const challenge = Challenge.from({
  id: 'challenge-id',
  method: 'tempo',
  intent: 'charge',
  request: { amount: '1000000', asset: '0x...', destination: '0x...' },
})
```

#### `Credential`

The credential passed to the `verify` function, containing the challenge ID and client payload.

```ts
type Credential<payload = unknown> = {
  /** The challenge ID from the original 402 response */
  id: string
  /** The validated credential payload */
  payload: payload
  /** Optional payer identifier as a DID (e.g., "did:pkh:eip155:1:0x...") */
  source?: string
}
```

```ts
import { Credential } from 'mpay'

const credential = Credential.from({
  id: 'challenge-id',
  payload: { signature: '0x...' },
})
```

#### `Receipt`

Payment receipt returned after successful verification, sent via the `Payment-Receipt` header.

```ts
type Receipt = {
  /** Payment status */
  status: 'success' | 'failed'
  /** ISO 8601 settlement timestamp */
  timestamp: string
  /** Method-specific reference (e.g., transaction hash) */
  reference: string
}
```

```ts
import { Receipt } from 'mpay'

const receipt = Receipt.from({
  status: 'success',
  timestamp: new Date().toISOString(),
  reference: '0x...',
})
```

### Server

#### `Intent.define`

Defines a payment intent — a type of payment operation (e.g., `charge`, `authorize`, `subscription`). Each intent specifies schemas for request validation and credential verification.

##### Definition

```ts
import { Credential, Schema } from 'mpay'

declare function define(options: {
  schema: {
    /** Standard schema for challenge request data */
    request: Schema.Schema
    /** Standard schema for credential payload the client sends back */
    credentialPayload: Schema.Schema
  }

  /** Verifies a credential and executes the payment */
  verify: (credential: Credential.Credential) => Promise<verify.ReturnValue>
}): Intent
```

> **Note:** `Schema.Schema` is a [Standard Schema](https://github.com/standard-schema/standard-schema) — an interoperable schema format supported by [Zod](https://zod.dev), [Valibot](https://valibot.dev), [ArkType](https://arktype.io), and others.

##### Example

This example uses [Zod](https://zod.dev), but any [Standard Schema](https://github.com/standard-schema/standard-schema)-compatible library works.

```ts
import { Intent } from 'mpay/server'
import { z } from 'zod'

const charge = Intent.define({
  schema: {
    request: z.object({
      amount: z.string(),
      asset: z.string(),
      destination: z.string(),
      expires: z.string(),
    }),
    credentialPayload: z.object({
      signature: z.string(),
    }),
  },

  verify(credential) {
    // ... verify the credential and execute the payment
    return {
      receipt: {
        status: 'success',
        timestamp: new Date().toISOString(),
        reference: '0x...',
      },
    }
  },
})
```