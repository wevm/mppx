# Stripe × mpay

End-to-end demo of the HTTP 402 payment flow using Stripe SPTs.

Uses Stripe.js Elements to collect a test card, creates a Shared Payment Token (SPT) via a server proxy, and sends it as a credential to a payment-gated API endpoint.

## Setup

1. Set your Stripe **test** keys in `.env` at the repo root:

```
VITE_STRIPE_PUBLIC_KEY=pk_test_...
VITE_STRIPE_SECRET_KEY=sk_test_...
```

2. Run the example:

```bash
pnpm install
pnpm dev
```

3. Enter a test card number (e.g. `4242 4242 4242 4242`, any future expiry, any CVC) and click **Get Fortune**.

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
  │  stripe.createPaymentMethod()  │                               │
  ├──────────────────────────────────────────────────────────────> │
  │                         pm_... │                               │
  │<────────────────────────────────────────────────────────────── │
  │                                │                               │
  │  POST /api/create-spt          │                               │
  ├──────────────────────────────> │                               │
  │                                │  POST /v1/.../granted_tokens  │
  │                                ├─────────────────────────────> │
  │                                │                   spt_...     │
  │                                │<───────────────────────────── │
  │                       spt_...  │                               │
  │<────────────────────────────── │                               │
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
