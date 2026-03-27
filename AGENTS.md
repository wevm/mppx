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

| Layer         | Spec                                                                                                                                        | Description                                                             |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Core**      | [draft-httpauth-payment-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/core/draft-httpauth-payment-00.md)                | 402 flow, `WWW-Authenticate`/`Authorization` headers, `Payment-Receipt` |
| **Intent**    | [draft-payment-intent-charge-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/intents/draft-payment-intent-charge-00.md)   | One-time immediate payment                                              |
| **Intent**    | [draft-payment-intent-session-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/intents/draft-payment-intent-session-00.md) | Pay-as-you-go streaming payments                                        |
| **Method**    | [draft-tempo-charge-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/methods/tempo/draft-tempo-charge-00.md)               | TIP-20 token transfers on Tempo                                         |
| **Method**    | [draft-tempo-session-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/methods/tempo/draft-tempo-session-00.md)             | Tempo payment channels for streaming                                    |
| **Extension** | [draft-payment-discovery-00](https://paymentauth.org/draft-payment-discovery-00.html)                                                       | OpenAPI-first discovery via `/openapi.json`                             |

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

## Commands

```bash
pnpm build            # Build with zile
pnpm check            # Lint with oxlint + format with oxfmt
pnpm check:types      # TypeScript type checking
pnpm check:types:html # TypeScript type checking for HTML payment pages (browser tsconfig)
pnpm test             # Run tests with vitest
pnpm test:html        # Run HTML e2e tests (Stripe + Tempo) with Playwright
pnpm check:types:examples # TypeScript type checking for examples/
```

## HTML Payment Pages

Browser-rendered payment pages live in `src/html/`. Each method (Tempo, Stripe) has its own directory with:

- `src/charge.ts` — Entry point, creates DOM and handles payment flow
- `src/env.d.ts` — Module augmentation for `MppxConfig` and `MppxChallengeRequest`
- `vite.config.ts` — Dev server and build config

### Build pipeline

`pnpm build` bundles each method's `charge.ts` into `{method}/server/internal/html.gen.ts` (generated, do not edit). The page shell is bundled into `server/internal/html.gen.ts`.

### Global types

- `src/html/env.d.ts` — Base global types (`mppx` var, `MppxConfig`, `MppxChallengeRequest`, `MppxEventMap`)
- Each method augments `MppxConfig` and `MppxChallengeRequest` via its own `src/env.d.ts`
- Browser tsconfig: `src/html/tsconfig.browser.json`

### Infrastructure routes (`mppx.html()`)

`Mppx.create()` returns an `html(request)` method that handles infrastructure routes:

- Service worker (`/__mppx_serviceWorker.js`)
- Method-registered routes (e.g., Stripe's `/__mppx_stripe_create_token`)

Methods register routes via `htmlRoutes` on `Method.toServer()`.

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
