# Stream: Multiple Fetches

Multiple paid requests over a single payment channel, then close and settle. Demonstrates a batch scraping use case where each fetch increments the cumulative voucher by 0.002 pathUSD.

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
