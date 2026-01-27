# mpay

HTTP Payment Authentication for TypeScript. Implements the ["Payment" HTTP Authentication Scheme](https://datatracker.ietf.org/doc/draft-ietf-httpauth-payment/) with pluggable payment methods & intents.

```
Client (Mpay)                                     Server (Mpay)
   │                                                   │
   │  (1) GET /resource                                │
   ├──────────────────────────────────────────────────>│
   │                                                   │
   │             (2) mpay.intent(request, { ... })     │
   │                   402 + WWW-Authenticate: Payment │
   │<──────────────────────────────────────────────────┤
   │                                                   │
   │  (3) mpay.createCredential(response)              │
   │                                                   │
   │  (4) GET /resource                                │
   │      Authorization: Payment <credential>          │
   ├──────────────────────────────────────────────────>│
   │                                                   │
   │               (5) intent.verify(request)          │
   │                                                   │
   │               (6) 200 OK                          │
   │                   Payment-Receipt: <receipt>      │
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

const mpay = Mpay.create({
  method: tempo({
    rpcUrl: 'https://rpc.tempo.xyz',
  }),
  realm: 'api.example.com',
})

export async function handler(request: Request) {
  const response = await mpay.charge({
    request: {
      amount: '1000000',
      currency: '0x20c0000000000000000000000000000000000001',
      recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00',
      expires: '2030-01-20T12:00:00Z',
    },
  })(request)

  // Payment required — send 402 response with challenge
  if (response.status === 402) return response.challenge

  // Payment verified — attach receipt and return resource
  return response.withReceipt(Response.json({ data: '...' }))
}
```

#### Node.js Compatibility

Use `toNodeListener` to wrap payment handlers for Node.js HTTP servers. It automatically handles 402 responses (writes headers, body, and ends the response) and sets the `Payment-Receipt` header on success.

```ts
import * as http from 'node:http'
import { toNodeListener } from 'mpay/server'

http.createServer(async (req, res) => {
  const result = await toNodeListener(
    mpay.charge({
      request: {
        amount: '1000000',
        currency: '0x20c0000000000000000000000000000000000001',
        recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00',
        expires: '2030-01-20T12:00:00Z',
      },
    }),
  )(req, res)

  // 402 response already sent
  if (result.status === 402) return

  // Payment verified — send resource
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
      account: privateKeyToAccount('0x...'),
      rpcUrl: 'https://rpc.tempo.xyz',
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
      rpcUrl: 'https://rpc.tempo.xyz',
    }),
  ],
})

// Use the wrapped fetch — handles 402 automatically
const res = await fetch('https://api.example.com/resource')
```

#### Manual

For more control, you can manually create credentials:

```ts
import { Challenge } from 'mpay' 
import { Mpay, tempo } from 'mpay/client'
import { privateKeyToAccount } from 'viem/accounts'

const mpay = Mpay.create({
  methods: [
    tempo({
      account: privateKeyToAccount('0x...'),
      rpcUrl: 'https://rpc.tempo.xyz',
    })
  ]
})

const res = await fetch('https://api.example.com/resource')
if (res.status !== 402) return

const credential = await mpay.createCredential(res)

// Retry with credential
const res2 = await fetch('https://api.example.com/resource', {
  headers: { 'Authorization': credential }
})
```

## API Reference

### Core

#### `Challenge.from`

Defines a challenge.

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

#### `Challenge.fromIntent`

Defines a challenge from an intent.

```ts
import { Challenge } from 'mpay'
import { Intents } from 'mpay/tempo'

const challenge = Challenge.fromIntent(Intents.charge, {
  id: 'challenge-id',
  realm: 'api.example.com',
  request: {
    amount: '1000000',
    currency: '0x20c0000000000000000000000000000000000001',
    recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
    expires: '2025-01-06T12:00:00Z',
    chainId: 42431,
  },
})
```

#### `Challenge.fromResponse`

Parses a challenge from a 402 response.

```ts
import { Challenge } from 'mpay'

const challenge = Challenge.fromResponse(response)
```

#### `Challenge.serialize`

Serialize a challenge to the WWW-Authenticate header format.

```ts
import { Challenge } from 'mpay'

const header = Challenge.serialize(challenge)
// => 'Payment id="...", realm="...", method="...", intent="...", request="..."'
```

#### `Challenge.deserialize`

Deserialize a WWW-Authenticate header value to a challenge.

```ts
import { Challenge } from 'mpay'

const challenge = Challenge.deserialize(header)
```

#### `Challenge.verify`

Verifies that a challenge ID matches the expected HMAC for the given parameters.

```ts
import { Challenge } from 'mpay'

const isValid = Challenge.verify(challenge, { secretKey: 'my-secret' })
```

#### `Credential.from`

Create a credential with a challenge ID and payload.

```ts
import { Credential } from 'mpay'

const credential = Credential.from({
  id: 'challenge-id',
  source: 'did:pkh:eip155:1:0x1234567890abcdef',
  payload: { signature: '0x...', type: 'transaction' },
})
```

#### `Credential.fromRequest`

Parses a credential from a request's Authorization header.

```ts
import { Credential } from 'mpay'

const credential = Credential.fromRequest(request)
```

#### `Credential.serialize`

Serialize a credential to the Authorization header format.

```ts
import { Credential } from 'mpay'

const header = Credential.serialize(credential)
// => 'Payment eyJpZCI6Li4ufQ'
```

#### `Credential.deserialize`

Deserialize an Authorization header value to a credential.

```ts
import { Credential } from 'mpay'

const credential = Credential.deserialize(header)
```

#### `Intent.from`

Define a method-agnostic intent with a validated request schema.

```ts
import { Intent, z } from 'mpay'

const charge = Intent.from({
  name: 'charge',
  schema: {
    request: z.object({
      amount: z.string(),
      currency: z.string(),
      description: z.optional(z.string()),
      expires: z.optional(z.string()),
      recipient: z.optional(z.string()),
    }),
  },
})
```

#### `MethodIntent.fromIntent`

Extend a base intent with method-specific details, required fields, and credential payload schema.

```ts
import { MethodIntent, z } from 'mpay'

const tempoCharge = MethodIntent.fromIntent(charge, {
  method: 'tempo',
  schema: {
    credential: {
      payload: z.object({
        signature: z.string(),
        type: z.literal('transaction'),
      }),
    },
    request: {
      methodDetails: z.object({
        chainId: z.optional(z.number()),
      }),
      requires: ['recipient', 'expires'],
    },
  },
})
```

#### `Receipt.from`

Create a payment receipt after successful verification.

```ts
import { Receipt } from 'mpay'

const receipt = Receipt.from({
  status: 'success',
  timestamp: new Date().toISOString(),
  reference: '0x...',
})
```

#### `Receipt.serialize`

Serialize a receipt to a base64url string for the Payment-Receipt header.

```ts
import { Receipt } from 'mpay'

const header = Receipt.serialize(receipt)
```

#### `Receipt.deserialize`

Deserialize a Payment-Receipt header value to a receipt.

```ts
import { Receipt } from 'mpay'

const receipt = Receipt.deserialize(header)
```

#### `Request.fromIntent`

Create a validated request from a method intent.

```ts
import { Request } from 'mpay'
import { Intents } from 'mpay/tempo'

const request = Request.fromIntent(Intents.charge, {
  amount: '1000000',
  currency: '0x20c0000000000000000000000000000000000001',
  recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
  expires: '2025-01-06T12:00:00Z',
  chainId: 42431,
})

```

#### `Request.serialize`

Serialize a request to a base64url string.

```ts
import { Request } from 'mpay'

const serialized = Request.serialize(request)
```

#### `Request.deserialize`

Deserialize a base64url string to a request.

```ts
import { Request } from 'mpay'

const request = Request.deserialize(serialized)
```

### Server

#### `Mpay.from`

Creates a server-side payment handler with configured intents.

```ts
import { Mpay } from 'mpay/server'
import { Intents } from 'mpay/tempo'

const payment = Mpay.from({
  method: 'tempo',
  realm: 'api.example.com',
  secretKey: 'my-secret-key',
  intents: {
    authorize: Intents.authorize,
    charge: Intents.charge,
  },
  async verify({ credential, request }) {
    // Verify the credential and return a receipt
    return { 
      method: 'tempo',
      status: 'success', 
      timestamp: new Date().toISOString(), 
      reference: '0x...' 
    }
  },
})
```

### Client

#### `Mpay.from`

Defines a client-side payment handler for a payment method.

```ts
import { Mpay } from 'mpay/client'
import { Intents } from 'mpay/tempo'

export function tempo(options: tempo.Options) {
  return Mpay.from({
    method: 'tempo',
    intents: {
      authorize: Intents.authorize,
      charge: Intents.charge,
      subscription: Intents.subscription,
    },
    async createCredential(response) {
      // ... parse challenge from response and create a credential
    },
  })
}
```

#### `Fetch.from`

Create a fetch function with payment handler(s).

```ts
import { Fetch, tempo } from 'mpay/client'

const fetch = Fetch.from({
  methods: [
    tempo({ 
      account, 
      rpcUrl: 'https://rpc.tempo.xyz' 
    })
  ],
})
```

#### `Fetch.polyfill`

Polyfill the global `fetch` function with payment handler(s).

```ts
import { Fetch } from 'mpay/client'

Fetch.polyfill({
  methods: [
    tempo({
      account,
      rpcUrl: 'https://rpc.tempo.xyz',
    }),
  ],
})
```