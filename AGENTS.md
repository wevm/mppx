# mppx

TypeScript implementation of the "Payment" HTTP Authentication Scheme (402 Protocol).

## Vision

mppx provides abstractions for the complete HTTP 402 payment flow — both client and server. The architecture has two layers:

### Core Abstractions

1. **`Mppx`** — Top-level payment handler. Groups related `Method`s and handles the HTTP 402 flow (challenge/credential parsing, header serialization, verification).

2. **`Method`** — A payment method definition. Each method has a `name` (e.g., `charge`, `session`), a `method` (e.g., `tempo`, `stripe`), and schemas for request validation and credential payloads.

```
┌────────────────────┐       ┌────────────────┐
│       Mppx         │ 1   * │     Method     │
│    (handler)       ├───────┤  (definition)  │
└────────────────────┘ has   └────────────────┘
│ payment            │       │ tempo/charge   │
│                    │       │ tempo/session  │
│                    │       │ stripe/charge  │
│                    │       │ whop/charge    │
└────────────────────┘       └────────────────┘
```

```
Client (Mppx)                                       Server (Mppx)
   │                                                   │
   │  (1) GET /resource                                │
   ├──────────────────────────────────────────────────>│
   │                                                   │
   │             (2) handler.charge(request, { ... })  │
   │                   402 + WWW-Authenticate: Payment │
   │<──────────────────────────────────────────────────┤
   │                                                   │
   │  (3) handler.createCredential(response)           │
   │                                                   │
   │  (4) GET /resource                                │
   │      Authorization: Payment <credential>          │
   ├──────────────────────────────────────────────────>│
   │                                                   │
   │               (5) handler.charge(request)         │
   │                                                   │
   │               (6) 200 OK                          │
   │                   Payment-Receipt: <receipt>      │
   │<──────────────────────────────────────────────────┤
   │                                                   │
```

### Primitives

Low-level data structures that compose into the core abstractions:

- **`Challenge`** — Server-issued payment request (appears in `WWW-Authenticate` header). Contains `id`, `realm`, `method`, `intent`, `request`, and optional `expires`/`digest`.
- **`Credential`** — Client-submitted payment proof (appears in `Authorization` header). Contains `challenge` echo, `payload` (method-specific proof), and optional `source` (payer identity).
- **`Method`** — Payment method definition (e.g., `tempo/charge`, `stripe/charge`). Contains `method`, `name`, and validated `schema` (credential payload + request).
- **`Mppx`** — Top-level payment handler. Groups related `Method`s and handles the HTTP 402 flow.
- **`Receipt`** — Server-issued settlement confirmation (appears in `Payment-Receipt` header). Contains `status`, `method`, `timestamp`, and `reference`.
- **`Request`** — Method-specific payment parameters (e.g., `amount`, `currency`, `recipient`). Validated by the method's schema and serialized in the challenge.

### Method Architecture

Methods are flat structural types with `method`, `name`, and `schema`:

```ts
const tempoCharge = Method.from({
  method: 'tempo',
  name: 'charge',
  schema: {
    credential: {
      payload: z.object({ signature: z.string(), type: z.literal('transaction') }),
    },
    request: z.pipe(
      z.object({
        amount: z.amount(),
        chainId: z.optional(z.number()),
        currency: z.string(),
        decimals: z.number(),
        recipient: z.optional(z.string()),
        // ...
      }),
      z.transform(({ amount, decimals, chainId, ... }) => ({
        amount: parseUnits(amount, decimals).toString(),
        ...(chainId !== undefined ? { methodDetails: { chainId } } : {}),
      })),
    ),
  },
})
```

Methods are extended with client or server logic via `Method.toClient()` and `Method.toServer()`:

```ts
// Client-side: adds credential creation
const client = Method.toClient(Methods.charge, {
  async createCredential({ challenge }) { ... },
})

// Server-side: adds verification
const server = Method.toServer(Methods.charge, {
  async verify({ credential }) { ... },
})
```

## Spec Reference

Canonical specs live at [tempoxyz/payment-auth-spec](https://github.com/tempoxyz/payment-auth-spec).

### Spec Documents

| Layer | Spec | Description |
|-------|------|-------------|
| **Core** | [draft-httpauth-payment-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/core/draft-httpauth-payment-00.md) | 402 flow, `WWW-Authenticate`/`Authorization` headers, `Payment-Receipt` |
| **Intent** | [draft-payment-intent-charge-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/intents/draft-payment-intent-charge-00.md) | One-time immediate payment |
| **Intent** | [draft-payment-intent-session-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/intents/draft-payment-intent-session-00.md) | Pay-as-you-go streaming payments |
| **Method** | [draft-tempo-charge-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/methods/tempo/draft-tempo-charge-00.md) | TIP-20 token transfers on Tempo |
| **Method** | [draft-tempo-session-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/methods/tempo/draft-tempo-session-00.md) | Tempo payment channels for streaming |
| **Method** | N/A (uses Whop public API) | Whop checkout-based fiat payments |
| **Extension** | [draft-payment-discovery-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/extensions/draft-payment-discovery-00.md) | `/.well-known/payment` discovery |

### Key Protocol Details

- **Challenge**: `WWW-Authenticate: Payment id="...", realm="...", method="...", intent="...", request="<base64url>"`
- **Credential**: `Authorization: Payment <base64url>` → `{ challenge, payload, source? }`
- **Receipt**: `Payment-Receipt: <base64url>` → `{ status, method, timestamp, reference }`
- **Encoding**: All JSON payloads use base64url without padding (RFC 4648)

### Challenge ID Binding

The challenge `id` is an HMAC-SHA256 over the challenge parameters, cryptographically binding the ID to its contents. This prevents tampering and ensures the server can verify challenge integrity without storing state.

**HMAC input** (concatenated, pipe-delimited):

```
realm | method | intent | request | expires | digest
```

**Generation:**

```
id = base64url(HMAC-SHA256(server_secret, input))
```

**Verification:** Server recomputes HMAC from echoed challenge parameters and compares to `id`. If mismatch, reject credential.

### Whop Method (`whop/charge`)

The `whop/charge` method uses Whop's existing public API for fiat payments — no Whop backend changes required.

**Flow:**
1. Server creates a Whop checkout configuration via `checkoutConfigurations.create()` and embeds the `purchase_url` in the challenge `meta`
2. Client opens the checkout URL (popup/new tab), user enters card and pays
3. Client sends the Whop payment ID as the credential payload
4. Server verifies via `payments.retrieve()` on the Whop API

**Server setup:**
```ts
import { Mppx, whop } from 'mppx/server'

const mppx = Mppx.create({
  methods: [
    whop({
      apiKey: process.env.WHOP_API_KEY!,  // or client: whopSdkInstance
      companyId: 'biz_xxx',
      currency: 'usd',
    }),
  ],
})

// In handler: create checkout config, pass purchase_url via meta
const checkout = await createCheckout({ apiKey, companyId, amount: 5.0 })
const result = await mppx.charge({
  amount: 5.0,
  meta: { purchase_url: checkout.purchase_url },
})(request)
```

**Client setup:**
```ts
import { Mppx, whop } from 'mppx/client'

const mppx = Mppx.create({
  methods: [
    whop({
      completeCheckout: async ({ purchaseUrl }) => {
        window.open(purchaseUrl, '_blank')
        // wait for payment completion, return payment ID
        return paymentId
      },
    }),
  ],
})
```

**Key files:**
- `src/whop/Methods.ts` — method definition (name: `whop`, intent: `charge`)
- `src/whop/client/Charge.ts` — client credential creation via `completeCheckout` callback
- `src/whop/server/Charge.ts` — server verification via Whop `payments.retrieve()`, plus `createCheckout` utility
- `src/whop/internal/types.ts` — duck-typed `WhopClient` interface
- `src/cli/plugins/whop.ts` — CLI plugin (opens browser, prompts for payment ID)
- `src/proxy/services/whop.ts` — Whop proxy service definition

**Environment variables:**
- `WHOP_API_KEY` — Whop Company or App API key (needs `checkout_configuration:create`, `payment:basic:read`)

## Commands

```bash
pnpm build          # Build with zile
pnpm check          # Lint and format with biome
pnpm check:types    # TypeScript type checking
pnpm test           # Run tests with vitest
```

## Skills Reference

Load these skills for specialized guidance:

### `payment-auth-scheme-author`

**Use when**: Implementing payment methods, understanding the 402 protocol flow, working with Tempo/Stripe payment method schemas, or referencing the IETF spec.

### `typescript-library-best-practices`

**Use when**: Building new modules, structuring exports, or following library patterns.

### `typescript-style-guide`

**Use when**: Writing or reviewing TypeScript code for style and conventions.

### `tempo-developer`

**Use when**: Referencing Tempo protocol specifics, understanding TIP-20 tokens, Tempo transactions (0x76), or protocol-level details.
