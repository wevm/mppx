# Stream: Multiple Fetches

Multiple paid requests over a single payment channel, then close and settle. Demonstrates a batch scraping use case where each fetch increments the cumulative voucher by 0.002 pathUSD.

## Restore after restart

Session persistence is caller-owned. If the client restarts between fetches,
save the latest `channelId`, cumulative amount, and optionally `spent`, then
resume with:

```ts
const manager = tempo.sessionManager({
  account,
  maxDeposit: '10',
  restore: {
    channelId: saved.channelId,
    cumulativeAmount: saved.cumulativeAmount,
    spent: saved.spent,
  },
})
```

After restart, `.close()` still requires one fresh paid request first so the
manager can receive a new challenge and remember the request URL.

## Setup

```bash
npx gitpick wevm/mppx/examples/session/multi-fetch
pnpm i
```

## Usage

Start the server:

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
pnpm mppx localhost:5173/api/scrape
pnpm mppx localhost:5173/api/scrape?url=https://example.com
```
