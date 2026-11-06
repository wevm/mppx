# Web Bot Auth with MPP

A paid API on Cloudflare Workers that only trusted bots may call, combining the Web Bot Auth HTTPS-directory profile with an automatic MPP payment flow. The client signs both the initial request and the payment retry with Ed25519. The server verifies the bot identity before issuing or accepting an MPP payment challenge.

## Setup

```bash
npx gitpick wevm/mppx/examples/web-bot-auth
pnpm i
pnpm keygen   # writes .dev.vars and .bot-key.json, funds the server account on testnet
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

An unsigned request to `/api/report` gets `403`. The signed request gets the `402` challenge, pays 0.01 pathUSD and returns the report with the verified bot key ID.

## How it works

[`src/client.ts`](./src/client.ts) passes a Web Bot Auth prover to `Mppx.create()` via
`identity`, scoped to the origins that should receive the signature. Every in-scope HTTP attempt
gets fresh `Signature-Agent`, `Signature-Input`, and `Signature` headers.

[`src/server.ts`](./src/server.ts) creates a trusted Web Bot Auth verifier and requires it per route:
`mppx.charge({ amount, identity: [webBotAuth] })`. Routes without `identity` stay open. In a
handler, `result.identity.get(webBotAuth)` returns the verified key ID and directory.

The verifier does not fetch the caller-controlled `Signature-Agent` URL. Its `keyResolver` first
applies application trust policy, then returns the public key (`BOT_PUBLIC_KEY`). A production
resolver can query an allowlisted directory after applying the same origin checks.

Signature nonces and spent payment credentials live in Durable Objects through
`Store.durableObject()`, so neither can be replayed on another isolate. Web Bot Auth proves which
bot key signed the request; the application must separately decide what the bot is authorized to do.

## Deploy

```bash
wrangler secret put MPP_PRIVATE_KEY   # from .dev.vars
wrangler secret put MPP_SECRET_KEY    # from .dev.vars
wrangler secret put BOT_PUBLIC_KEY    # from .dev.vars
wrangler secret put TEMPO_RPC_URL     # optional: a dedicated Tempo RPC
pnpm deploy
BASE_URL=https://mppx-web-bot-auth.<account>.workers.dev pnpm client
```
