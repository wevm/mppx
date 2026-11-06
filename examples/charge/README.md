# Charge

A barebones payment-gated photo API on Cloudflare Workers, with a web page that pays per photo. The server sponsors gas (`feePayer: true`) and serves a payment page to browsers (`html: true`). Used credentials are recorded in Durable Objects through `Store.durableObject()`.

## Setup

```bash
npx gitpick wevm/mppx/examples/charge
pnpm i
pnpm keygen   # writes .dev.vars and funds the server account on testnet
```

## Usage

Start the Worker and the page locally:

```bash
pnpm dev
```

Open http://localhost:8787 and generate a photo: the page funds an ephemeral account from the testnet faucet and pays 0.01 per photo.

## Test with mppx CLI

With the server running, use the `mppx` CLI to make a paid request:

```bash
pnpm mppx localhost:8787/api/photo
```

## Deploy

```bash
wrangler secret put MPP_PRIVATE_KEY   # from .dev.vars
wrangler secret put MPP_SECRET_KEY    # from .dev.vars
wrangler secret put TEMPO_RPC_URL     # optional: a dedicated Tempo RPC
pnpm deploy
```
