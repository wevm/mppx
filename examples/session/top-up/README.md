# Session: Top-up

A prepaid, pay-per-request API on Cloudflare Workers. The client opens a payment channel with a small deposit, pays each request with an off-chain voucher, and tops up the same channel when it runs low: automatically with `topUpAmount`, or ahead of time with `session.topUp()`. Channel state lives in Durable Objects through `Store.durableObject()`.

## Setup

```bash
npx gitpick wevm/mppx/examples/session/top-up
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

The server suggests a 0.03 deposit (3 requests at 0.01). The client tops up 0.05 at a time, capped at `maxDeposit` 0.2, then prefunds 0.1 with `session.topUp()` and closes the channel, which refunds what it didn't spend.

## Client

```ts
const session = tempo.session.manager({
  account,
  client,
  maxDeposit: '0.2', // most ever locked in the channel
  topUpAmount: '0.05', // added each time the deposit runs out
})

await session.fetch(url) // opens, pays, tops up as needed
await session.topUp('0.1') // prefund, such as when a user buys credits
await session.close() // settle and refund the rest
```

## Deploy

```bash
wrangler secret put MPP_PRIVATE_KEY   # from .dev.vars
wrangler secret put MPP_SECRET_KEY    # from .dev.vars
wrangler secret put TEMPO_RPC_URL     # optional: a dedicated Tempo RPC
pnpm deploy
BASE_URL=https://mppx-session-top-up.<account>.workers.dev pnpm client
```
