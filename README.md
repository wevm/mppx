<picture>
  <source media="(prefers-color-scheme: dark)" srcset=".github/logo-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset=".github/logo-light.svg">
  <img alt="mppx" src=".github/logo-light.svg" width="100%" height="100px">
</picture>

<p></p>

<p align="center"><b>TypeScript SDK for the <a href="https://mpp.dev">Machine Payments Protocol</a></b></p>

<p align="center">
  <a href="https://mpp.dev/sdk/typescript">Documentation</a> · <a href="#install">Install</a> · <a href="#quick-start">Quick Start</a> · <a href="#examples">Examples</a> · <a href="#cli">CLI</a> · <a href="#payments-proxy">Payments Proxy</a> · <a href="https://github.com/tempoxyz/mpp-specs">Protocol</a>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/mppx">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/npm/v/mppx?colorA=21262d&colorB=21262d&style=flat">
      <img src="https://img.shields.io/npm/v/mppx?colorA=f6f8fa&colorB=f6f8fa&style=flat" alt="Version">
    </picture>
  </a>
  <a href="https://github.com/wevm/mppx/blob/main/LICENSE">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://img.shields.io/npm/l/mppx?colorA=21262d&colorB=21262d&style=flat">
      <img src="https://img.shields.io/npm/l/mppx?colorA=f6f8fa&colorB=f6f8fa&style=flat" alt="MIT License">
    </picture>
  </a>
</p>

---

## Documentation

Full documentation, API reference, and guides are available at **[mpp.dev/sdk/typescript](https://mpp.dev/sdk/typescript)**.

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
const res = await fetch('https://mpp.dev/api/ping/paid')
```

## Tempo Sessions

`tempo.session()` creates the low-level `tempo/session` client method for `Mppx.create()`. Use `tempo.session.manager()` when you want direct lifecycle control for HTTP, SSE, WebSocket, top-up, and close flows.

### Managed Client

```ts
import { tempo } from 'mppx/client'

const session = tempo.session.manager({
  account,
  client,
  maxDeposit: '1',
  bootstrap: true,
  sessionStore: {
    get: () => JSON.parse(localStorage.getItem('mppx-session') ?? 'null'),
    set: (channel) => localStorage.setItem('mppx-session', JSON.stringify(channel)),
    delete: () => localStorage.removeItem('mppx-session'),
  },
})

const response = await session.fetch('/api/search')
const stream = await session.sse('/api/chat')
await session.close()
```

`sessionStore` lets a client persist the latest channel hint between manager instances or page reloads. Stored channels are sent as a `Payment-Session` request header. Servers can use that hint to return a fresh `Payment-Session-Snapshot`, allowing the client to hydrate state without manually passing channel descriptors around.

```ts
type SessionStore = {
  get(): StoredSessionChannel | null | undefined | Promise<StoredSessionChannel | null | undefined>
  set(channel: StoredSessionChannel): void | Promise<void>
  delete?(): void | Promise<void>
}
```

Stored channel fields:

| Field              | Description                                                         |
| ------------------ | ------------------------------------------------------------------- |
| `channelId`        | Latest known TIP-1034 channel ID.                                   |
| `cumulativeAmount` | Latest local cumulative voucher authorization in raw token units.   |
| `deposit`          | Latest known deposit in raw token units.                            |
| `descriptor`       | Channel descriptor used to recover when the server cannot snapshot. |
| `escrow`           | Escrow address used to derive the channel ID.                       |
| `chainId`          | Chain ID used to derive the channel ID.                             |
| `opened`           | Whether the channel was open when persisted.                        |
| `updatedAt`        | Client timestamp for app-level eviction or debugging.               |

Managed client options:

| Option             | Description                                                                                 |
| ------------------ | ------------------------------------------------------------------------------------------- |
| `account`          | Viem account used to sign vouchers.                                                         |
| `getClient`        | Lazy viem client resolver.                                                                  |
| `client`           | Viem client shorthand for `getClient: () => client`.                                        |
| `authorizedSigner` | Address authorized to sign vouchers. Defaults to the account access key address or account. |
| `bootstrap`        | Enables same-route `HEAD` bootstrap before opening a new channel.                           |
| `decimals`         | Token decimals used to parse `maxDeposit`. Defaults to `6`.                                 |
| `escrow`           | TIP-1034 escrow precompile override.                                                        |
| `fetch`            | Fetch implementation used for probes, retries, and management posts.                        |
| `maxDeposit`       | Maximum human-readable deposit to lock or top up into the channel.                          |
| `sessionStore`     | Optional persisted channel hint store.                                                      |
| `webSocket`        | WebSocket constructor for runtimes without a global `WebSocket`.                            |

Managed client fields and methods:

| Member       | Description                                                                                  |
| ------------ | -------------------------------------------------------------------------------------------- |
| `channelId`  | Active channel ID, when a channel has been opened or recovered.                              |
| `cumulative` | Local cumulative voucher authorization in raw token units.                                   |
| `opened`     | Whether the manager currently has an open local channel.                                     |
| `state`      | Current pure session state-machine state.                                                    |
| `fetch()`    | Runs the HTTP 402 flow, signs/open/top-ups as needed, retries, and returns receipt metadata. |
| `sse()`      | Opens a paid SSE stream and automatically posts vouchers/top-ups as needed.                  |
| `ws()`       | Opens a paid WebSocket session and manages in-band voucher frames.                           |
| `topUp()`    | Tops up the active channel deposit. String amounts use manager decimals; bigint is raw.      |
| `close()`    | Cooperatively closes the active channel and returns the final receipt when available.        |

### Server Bootstrap

Servers opt into same-route bootstrap with `bootstrap: true` and a `resolveChannelId` hook. The hook receives request metadata, the verified payer `source` for `$0` identity bootstrap, the payment request, and the session store. Return a channel ID when the server can associate the request with an existing channel.

```ts
import { tempo } from 'mppx/server'

tempo.session({
  store,
  bootstrap: true,
  resolveChannelId({ request, source, credential, paymentRequest, store }) {
    return request?.headers.get('Payment-Session') ?? lookupChannelId(source)
  },
})
```

When a channel is found, the server responds with:

| Header                     | Description                                     |
| -------------------------- | ----------------------------------------------- |
| `Payment-Session`          | Channel ID hint for the reusable session.       |
| `Payment-Session-Snapshot` | Serialized channel snapshot used for hydration. |

Server bootstrap options:

| Option             | Description                                                                                                |
| ------------------ | ---------------------------------------------------------------------------------------------------------- |
| `bootstrap`        | Enables same-route `HEAD` bootstrap using a zero-amount Tempo charge proof.                                |
| `resolveChannelId` | Resolves a reusable channel ID from request identity, source, credential, payment request, or store state. |
| `store`            | Atomic store backend for channel state.                                                                    |

## Examples

| Example                                                | Description                                          |
| ------------------------------------------------------ | ---------------------------------------------------- |
| [charge](./examples/charge/)                           | Payment-gated photo generation API                   |
| [charge-wagmi](./examples/charge-wagmi/)               | Payment-gated charge with Wagmi + React              |
| [session/multi-fetch](./examples/session/multi-fetch/) | Multiple paid requests over a single payment channel |
| [session/sse](./examples/session/sse/)                 | Pay-per-token LLM streaming with SSE                 |
| [stripe](./examples/stripe/)                           | Stripe SPT charge with automatic client              |

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

| Route                              | Pricing                      |
| ---------------------------------- | ---------------------------- |
| `POST /openai/v1/chat/completions` | charge **$0.005**            |
| `POST /openai/v1/completions`      | stream **$0.0001 per token** |
| `GET /openai/v1/models`            | free                         |
| `POST /stripe/v1/charges`          | charge **$0.01**             |
| `GET /stripe/v1/customers/:id`     | free                         |

## Protocol

Built on the ["Payment" HTTP Authentication Scheme](https://datatracker.ietf.org/doc/draft-ryan-httpauth-payment/). See [mpp-specs](https://github.com/tempoxyz/mpp-specs) for the full specification.

## License

MIT
