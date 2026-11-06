# Session: Cloudflare Workers

Pay-per-token LLM streaming over SSE, deployed as a Cloudflare Worker. Channel state lives in Durable Objects through `Store.durableObject()`, so the stream, the mid-stream voucher `POST`s and the close can land on any isolate and still see one atomic channel.

## Setup

```bash
npx gitpick wevm/mppx/examples/session/cloudflare
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
pnpm client "What is the meaning of life?"
```

## Deploy

```bash
wrangler secret put MPP_PRIVATE_KEY   # from .dev.vars
wrangler secret put MPP_SECRET_KEY    # from .dev.vars
wrangler secret put TEMPO_RPC_URL     # optional: a dedicated Tempo RPC
pnpm deploy
BASE_URL=https://mppx-session-cloudflare.<account>.workers.dev pnpm client
```

## How it works

```ts
import { Mppx, Store, tempo } from 'mppx/server'

// Bound as MPPX_STORE with a new_sqlite_classes migration in wrangler.jsonc.
export class MppxStore extends Store.DurableObjectStore {}

tempo.session({
  account,
  currency,
  getClient,
  sse: true,
  store: Store.durableObject(env.MPPX_STORE),
})
```

Each channel gets its own Durable Object, so channels scale out across objects while every update to one channel is serialized.

## Test with mppx CLI

```bash
pnpm mppx localhost:8787/api/chat
```
