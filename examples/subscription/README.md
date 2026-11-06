# Tempo Subscription

Recurring access-key subscription for a news app on Cloudflare Workers. The server charges `0.10` pathUSD per day by deriving the subscription key from the signed payer identity, returning a Tempo access key in the MPP challenge, then requiring a `keyAuthorization` scoped to that key. Subscriptions live in Durable Objects through `Store.durableObject()`.

The example opts into credential-required reuse, so access is keyed from the payer signature instead of a user-controlled header.

## Setup

```bash
npx gitpick wevm/mppx/examples/subscription
pnpm i
pnpm keygen   # writes .dev.vars and funds the server account on testnet
```

## Usage

Start the Worker locally:

```bash
pnpm dev
```

In a separate terminal, run the client:

```bash
pnpm client
```

The client:

1. Requests `/api/article` and receives a `402` challenge with a server access key.
2. Signs a `keyAuthorization`; the server derives the subscription key from the recovered payer.
3. Requests `/api/article` again, signs a fresh credential, and reuses the active subscription without another charge.

## Test with mppx CLI

With the Worker running, use the `mppx` CLI to inspect the challenge:

```bash
pnpm mppx localhost:8787/api/article
```

## Deploy

```bash
wrangler secret put MPP_PRIVATE_KEY   # from .dev.vars
wrangler secret put MPP_SECRET_KEY    # from .dev.vars
wrangler secret put TEMPO_RPC_URL     # optional: a dedicated Tempo RPC
pnpm deploy
BASE_URL=https://mppx-subscription.<account>.workers.dev pnpm client
```
