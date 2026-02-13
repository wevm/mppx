# mppx

TypeScript implementation of the "Payment" HTTP Authentication Scheme (402 Protocol).

## Vision

mppx provides abstractions for the complete HTTP 402 payment flow — both client and server. The architecture has three layers:

### Core Abstractions

1. **`PaymentHandler`** — Top-level abstraction over a payment method. Groups related `MethodIntent`s and handles the HTTP 402 flow (challenge/credential parsing, header serialization, verification).

2. **`Intent`** — Method-agnostic action definitions. Standard intents include `charge`, `authorize`, and `subscription`. Each intent defines what the server requests and validates the request schema.

3. **`MethodIntent`** — Method-specific intent extensions. Each method intent adds credential payload schemas, method-specific details, and can require optional base fields.

```
┌────────────────────┐       ┌────────────────┐       ┌─────────────────┐
│   PaymentHandler   │ 1   * │  MethodIntent  │ *   1 │     Intent      │
│     (method)       ├───────┤   (adapter)    ├───────┤    (action)     │
└────────────────────┘ has   └────────────────┘extends└─────────────────┘
│ tempo              │       │ tempo/charge   │       │ charge          │
│ stripe             │       │ tempo/authorize│       │ authorize       │
│ x402               │       │ stripe/charge  │       │ subscription    │
└────────────────────┘       └────────────────┘       └─────────────────┘
```

```
Client (PaymentHandler)                             Server (PaymentHandler)
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
- **`Intent`** — Method-agnostic action definition (e.g., `charge`, `authorize`, `subscription`). Contains `name` and validated `request` schema.
- **`MethodIntent`** — Method-specific intent extension. Adds `methodDetails`, `requires` constraints, and `credential.payload` schema to a base `Intent`.
- **`PaymentHandler`** — Top-level abstraction over a payment method. Groups related `MethodIntent`s and handles the HTTP 402 flow.
- **`Receipt`** — Server-issued settlement confirmation (appears in `Payment-Receipt` header). Contains `status`, `method`, `timestamp`, and `reference`.
- **`Request`** — Intent-specific payment parameters (e.g., `amount`, `currency`, `recipient`). Validated by the intent's schema and serialized in the challenge.

### Intent Architecture

Intents follow a two-layer design:

1. **Base Intents** (`Intent.ts`) — Method-agnostic intent definitions. Define the core request schema with optional fields where methods may vary.

2. **Method Intents** (`MethodIntent.ts`) — Method-specific extensions via `MethodIntent.fromIntent()`. Can:
   - Add `methodDetails` (extra fields like `chainId`, `feePayer`)
   - Use `requires` to make optional base fields mandatory
   - Define method-specific `credential.payload` schemas

```ts
// Base intent with validated fields
const charge = Intent.from({
  name: 'charge',
  schema: {
    request: z.object({
      amount,                             // required: numeric string
      currency: z.string(),               // required
      description: z.optional(z.string()),
      expires: z.optional(datetime),      // ISO 8601
      externalId: z.optional(z.string()),
      recipient: z.optional(z.string()),
    }),
  },
})

// Tempo requires recipient, adds chainId
const tempoCharge = MethodIntent.fromIntent(charge, {
  method: 'tempo',
  schema: {
    credential: { payload: z.object({ ... }) },
    request: {
      methodDetails: z.object({ chainId: z.optional(z.number()) }),
      requires: ['recipient'],  // Makes recipient non-optional
    },
  },
})
```

## Spec Reference

Canonical specs live at [tempoxyz/payment-auth-spec](https://github.com/tempoxyz/payment-auth-spec).

### Spec Documents

| Layer | Spec | Description |
|-------|------|-------------|
| **Core** | [draft-httpauth-payment-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/core/draft-httpauth-payment-00.md) | 402 flow, `WWW-Authenticate`/`Authorization` headers, `Payment-Receipt` |
| **Intent** | [draft-payment-intent-charge-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/intents/draft-payment-intent-charge-00.md) | One-time immediate payment |
| **Intent** | [draft-payment-intent-authorize-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/intents/draft-payment-intent-authorize-00.md) | Pre-authorization for later capture |
| **Intent** | [draft-payment-intent-subscription-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/intents/draft-payment-intent-subscription-00.md) | Recurring periodic payments |
| **MethodIntent** | [draft-tempo-charge-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/methods/tempo/draft-tempo-charge-00.md) | TIP-20 token transfers on Tempo |
| **MethodIntent** | [draft-tempo-authorize-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/methods/tempo/draft-tempo-authorize-00.md) | Access Key delegation with limits |
| **MethodIntent** | [draft-stripe-charge-00](https://github.com/tempoxyz/payment-auth-spec/blob/main/specs/methods/stripe/draft-stripe-charge-00.md) | Stripe Payment Tokens (SPTs) |
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

**Use when**: Implementing payment intents, understanding the 402 protocol flow, working with Tempo/Stripe payment method schemas, or referencing the IETF spec.

### `typescript-library-best-practices`

**Use when**: Building new modules, structuring exports, or following library patterns.

### `typescript-style-guide`

**Use when**: Writing or reviewing TypeScript code for style and conventions.

### `tempo-developer`

**Use when**: Referencing Tempo protocol specifics, understanding TIP-20 tokens, Tempo transactions (0x76), or protocol-level details.
