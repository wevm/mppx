# Stream: Multiple Fetches

Multiple paid requests over a single payment channel, then close and settle. Demonstrates a batch scraping use case where each fetch increments the cumulative voucher by 0.01 pathUSD.

Each paid HTTP response carries a `Payment-Receipt` header. For session routes, the receipt's `spent` and `units` fields reflect channel state after that request, which is what standalone clients should use for follow-up close flows.

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
