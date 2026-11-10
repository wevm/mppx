# Stream: Multiple Fetches

Multiple paid requests over a single payment channel, then close and settle. Demonstrates a batch scraping use case where each fetch increments the cumulative voucher by 0.01 pathUSD. The server is a Cloudflare Worker; channel state lives in Durable Objects through `Store.durableObject()`.

Each paid HTTP response carries a `Payment-Receipt` header. For session routes, the receipt's `spent` and `units` fields reflect channel state after that request, which is what standalone clients should use for follow-up close flows.

For recovery after a client restart, see the [Tempo Sessions design](../../../src/tempo/session/README.md).

## Setup

```bash
npx gitpick wevm/mppx/examples/session/multi-fetch
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

## Test with mppx CLI

With the server running, use the `mppx` CLI to make a paid request:

```bash
pnpm mppx localhost:8787/api/scrape
pnpm mppx localhost:8787/api/scrape/https%3A%2F%2Fexample.com
```

## Deploy

```bash
wrangler secret put MPP_PRIVATE_KEY   # from .dev.vars
wrangler secret put MPP_SECRET_KEY    # from .dev.vars
wrangler secret put TEMPO_RPC_URL     # optional: a dedicated Tempo RPC
pnpm deploy
BASE_URL=https://mppx-session-multi-fetch.<account>.workers.dev pnpm client
```
