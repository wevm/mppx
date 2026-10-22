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

Contributors changing Tempo sessions should read the [session design](./src/tempo/session/README.md) before altering credential, recovery, accounting, or transport behavior.

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
      recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00',
    }),
  ],
  secretKey: process.env.MPP_SECRET_KEY!,
})

export async function handler(request: Request) {
  const response = await mppx.charge({ amount: '1' })(request)

  if (response.status === 402) return response.challenge

  return response.withReceipt(Response.json({ data: '...' }))
}
```

Generate `MPP_SECRET_KEY` with at least 32 bytes, for example: `openssl rand -base64 32`.

### Dynamic prices

A challenge `id` is an HMAC over the issued parameters, including the serialized `request`. `Challenge.verify` recomputes that HMAC from the echoed challenge and compares it to the echoed `id`. `mppx.charge()` builds the challenge it will sign from the `amount` you pass in. When that HMAC check fails, it returns this new challenge (`src/server/Mppx.ts`). Deserialize the credential, then call `Challenge.verify` with the same `MPP_SECRET_KEY`. Use `challenge.request.amount` only when that check succeeds and the value sits between a floor and a ceiling of your current quote (for example, at least 90% and at most 110%). Otherwise pass the live quote, including when the `Payment` credential is absent or the HMAC fails, so the replacement challenge is signed at the current price.

Tempo, Stripe, and EVM store the echoed amount in base units, after scaling the decimal `amount` passed to `charge()` by the method's `decimals`. `getChallengeBindingMismatch` then compares that signed amount with the echoed challenge, so an in-band verified amount has to be the one passed to `charge()`. Convert it back with `formatUnits` and those `decimals` (Tempo's default token uses `6`). Other pinned fields, such as `currency` and `recipient`, still have to match. `Credential.extractPaymentScheme` reads the `Payment` value from `Authorization`; with `requiresAuth: true`, read `Payment-Authorization`. In the snippet, `decimals` is the method's decimals, `mppx` is the handler above, and `currentQuoteBaseUnits()` returns the quote in base units.

```ts
import { Challenge, Credential } from 'mppx'
import { formatUnits } from 'viem'

const quote = await currentQuoteBaseUnits()
let base = quote
const payment = Credential.extractPaymentScheme(request.headers.get('Authorization') ?? '')
if (payment) {
  const credential = Credential.deserialize(payment)
  const echoed = credential.challenge.request.amount
  if (
    typeof echoed === 'string' &&
    /^\d+$/.test(echoed) &&
    Challenge.verify(credential.challenge, { secretKey: process.env.MPP_SECRET_KEY! })
  ) {
    const echoedBase = BigInt(echoed)
    if (echoedBase * 10n >= quote * 9n && echoedBase * 10n <= quote * 11n) base = echoedBase
  }
}

const response = await mppx.charge({ amount: formatUnits(base, decimals) })(request)
if (response.status === 402) return response.challenge
return response.withReceipt(Response.json({ data: '...' }))
```

### Client

```ts
import { Mppx, tempo } from 'mppx/client'
import { privateKeyToAccount } from 'viem/accounts'

Mppx.create({
  methods: [tempo({ account: privateKeyToAccount('0x...') })],
})

// Global fetch now handles 402 automatically
const res = await fetch('https://mpp.dev/api/ping/paid')
```

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

`mppx` includes a basic CLI for making HTTP requests with automatic payment handling. Tempo
session channels are retained and reused automatically until you close them.

```bash
# create account - stored in keychain, autofunded on testnet
mppx account create

# make request - automatic payment handling, curl-like api
mppx example.com

# pay an x402 offer on a server that advertises both protocols
mppx example.com --protocol x402

# open another session instead of reusing the preferred channel
mppx example.com --session new

# inspect and close retained sessions
mppx sessions list
mppx sessions view <channel-id>
mppx sessions close <channel-id>
mppx sessions close --all --yes

# explicitly trust a custom session escrow advertised by the server
mppx example.com -M allowCustomEscrow=true
```

`--session auto` is the default. Pass `new` to open another channel or a channel ID to select one
explicitly.

Tempo session clients accept only the canonical escrow contract by default. A server may advertise
its configured custom escrow in the payment challenge, but the client rejects it unless
`-M allowCustomEscrow=true` is supplied. This opt-in trusts the server-selected address; clients
that do not support custom escrows should leave it unset. See the
[session escrow trust documentation](./src/tempo/session/README.md#escrow-configuration-and-trust).

`--protocol auto` is the default: MPP is preferred when available, and x402 is used otherwise.
Pass `mpp` or `x402` to require one protocol. x402 payments use the same EVM account as EVM
charges, so `MPPX_PRIVATE_KEY` or a stored account works for both.

Payment extensions can enforce policy or prepare funds after challenge selection and confirmation,
immediately before credential creation:

```ts
import { defineConfig, Extension } from 'mppx/cli'

export default defineConfig({
  extensions: [
    Extension.from({
      async preparePayment({ challenge }) {
        await prepareFunds(challenge)
      },
    }),
  ],
})
```

Extensions run in configuration order. Throwing rejects the payment before Mppx signs it.

You can also install globally to use the `mppx` CLI from anywhere:

```bash
npm i -g mppx
```

## Payments Proxy

`mppx` exports a `Proxy` server handler so that you can create or define a 402-protected payments proxy for any API.

```ts
import { openai, stripe, Proxy } from 'mppx/proxy'
import { Mppx, tempo } from 'mppx/server'

const mppx = Mppx.create({
  methods: [tempo()],
  secretKey: process.env.MPP_SECRET_KEY!,
})

const proxy = Proxy.create({
  services: [
    openai({
      apiKey: 'sk-...',
      routes: {
        'POST /v1/chat/completions': mppx.charge({ amount: '0.05' }),
        'POST /v1/completions': mppx.tempo.session({
          amount: '0.0001',
          unitType: 'token',
        }),
        'GET /v1/models': true,
      },
    }),
    stripe({
      apiKey: 'sk-...',
      routes: {
        'POST /v1/charges': mppx.charge({ amount: '0.01' }),
        'GET /v1/customers/:id': true,
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

| Route                              | Pricing                       |
| ---------------------------------- | ----------------------------- |
| `POST /openai/v1/chat/completions` | charge **$0.005**             |
| `POST /openai/v1/completions`      | session **$0.0001 per token** |
| `GET /openai/v1/models`            | free                          |
| `POST /stripe/v1/charges`          | charge **$0.01**              |
| `GET /stripe/v1/customers/:id`     | free                          |

## Protocol

Built on the ["Payment" HTTP Authentication Scheme](https://datatracker.ietf.org/doc/draft-ryan-httpauth-payment/). See [mpp-specs](https://github.com/tempoxyz/mpp-specs) for the full specification.

## License

MIT

### Accepted Tempo currencies

`tempo()`, `tempo.charge()`, `tempo.session()`, and `tempo.subscription()` offer OUSD first, followed by USDC.e on mainnet or pathUSD on Moderato (`testnet: true`). Each factory returns a group accepted directly by `Mppx.create`. Clients choose one offer; ordering does not trigger an automatic swap.

```ts
import { Mppx, tempo } from 'mppx/server'
import { ousd, usdce } from 'viem/tokens'

const mppx = Mppx.create({
  methods: [
    tempo.charge({
      currencies: [ousd, usdce],
      recipient: '0x742d35Cc6634c0532925a3b844bC9e7595F8fE00',
    }),
  ],
})
```

Omit `currencies` for the network defaults, or use `currencies: [ousd]` to accept only OUSD on mainnet. Explicit lists replace the defaults. The deprecated `currency` option also restricts acceptance to one token. Wire requests and handler overrides continue to use singular `currency`.

Use configured handlers such as `mppx.tempo.charge` when composing payments. Code that directly inspects a Method can destructure the group: `const [charge] = tempo.charge({ currencies: [ousd] })`. Existing sessions and subscriptions continue using their originally authorized currency.
