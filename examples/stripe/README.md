# Stripe × mppx

End-to-end demo of the HTTP 402 payment flow using Stripe SPTs and Stripe.js, with the server on Cloudflare Workers.

Uses the automatic mppx client — `Mppx.create()` polyfills `globalThis.fetch` so any `fetch()` call that gets a 402 automatically runs `onChallenge`, creates an SPT, and retries with the credential. The server verifies the SPT by creating a Stripe PaymentIntent.

The server advertises supported payment methods and a Stripe Business Network profile ID in `methodDetails`. The client uses those values to create an SPT, then retries with the credential payload.

## Setup

```bash
npx gitpick wevm/mppx/examples/stripe
pnpm i
```

Write your Stripe **test** keys. The Worker reads `.dev.vars`; the browser page reads `VITE_STRIPE_PUBLIC_KEY` from `.env`:

```bash
cat > .dev.vars <<EOF
MPP_SECRET_KEY=$(openssl rand -base64 32)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLIC_KEY=pk_test_...
EOF
chmod 600 .dev.vars
echo VITE_STRIPE_PUBLIC_KEY=pk_test_... > .env
```

## Usage

Start the Worker and the page locally:

```bash
pnpm dev
```

Open http://localhost:8787 and click **Get Fortune**. The 402 handshake happens automatically.

## Test with mppx CLI

With the Worker running, use the `mppx` CLI to make a paid request:

```bash
MPPX_STRIPE_SECRET_KEY=sk_test_...
pnpm mppx localhost:8787/api/fortune
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

## Deploy

```bash
wrangler secret put MPP_SECRET_KEY      # from .dev.vars
wrangler secret put STRIPE_SECRET_KEY
wrangler secret put STRIPE_PUBLIC_KEY
pnpm deploy                             # builds the page with VITE_STRIPE_PUBLIC_KEY from .env
```
