# Stripe × mppx

End-to-end demo of the HTTP 402 payment flow using Stripe SPTs and Stripe.js.

Uses the automatic mppx client — `Mppx.create()` polyfills `globalThis.fetch` so any `fetch()` call that gets a 402 automatically runs `onChallenge`, creates an SPT, and retries with the credential. The server verifies the SPT by creating a Stripe PaymentIntent.

The server advertises supported payment methods and a Stripe Business Network profile ID in `methodDetails`. The client uses those values to create an SPT, then retries with the credential payload.

## Setup

1. Set your Stripe **test** keys in `.env` at the repo root:

```
VITE_STRIPE_SECRET_KEY=sk_test_...
VITE_STRIPE_PUBLIC_KEY=pk_test_...
```

2. Run the example:

```bash
pnpm install
pnpm dev
```

3. Click **Get Fortune** — the 402 handshake happens automatically.

## Test with mppx CLI

With the server running, use the `mppx` CLI to make a paid request:

```bash
MPPX_STRIPE_SECRET_KEY=sk_test_...
pnpm mppx localhost:5173/api/fortune
```

## Flow

```
Browser                          Server                          Stripe
  │                                │                               │
  │  GET /api/fortune              │                               │
  ├──────────────────────────────> │                               │
  │                                │                               │
  │  402 + WWW-Authenticate        │                               │
  │<────────────────────────────── │                               │
  │                                │                               │
  │  (mppx auto: onChallenge)      │                               │
  ├──────────────────────────────────────────────────────────────> │
  │                       spt_...  │                               │
  │<────────────────────────────────────────────────────────────── │
  │                                │                               │
  │  GET /api/fortune              │                               │
  │  Authorization: Payment <cred> │                               │
  ├──────────────────────────────> │                               │
  │                                │  PaymentIntent (using SPT)    │
  │                                ├─────────────────────────────> │
  │                                │                   pi_...      │
  │                                │<───────────────────────────── │
  │  200 OK + Payment-Receipt      │                               │
  │<────────────────────────────── │                               │
```
