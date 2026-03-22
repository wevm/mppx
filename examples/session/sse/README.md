# Stream: SSE

Pay-per-token LLM streaming using the SSE handler API. The server uses `tempo.Sse.from()` to create an SSE response that charges per token via `stream.charge()`. The client uses `session.sse()` to consume tokens as an async iterable, automatically handling voucher top-ups and receipts.

## Restore after restart

Session persistence is caller-owned. If the client restarts, save the latest
`channelId`, cumulative amount, and optionally `spent`, then pass them back via
`restore` when constructing the next `sessionManager` instance.

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

After restart, `.close()` still needs one fresh paid request first so the
manager can receive a new challenge and remember the request URL.

## Setup

```bash
npx gitpick wevm/mppx/examples/session/sse
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
pnpm client "What is the meaning of life?"
```

## Test with mppx CLI

With the server running, use the `mppx` CLI to make a paid request:

```bash
pnpm mppx localhost:5173/api/chat
pnpm mppx localhost:5173/api/chat?prompt=What+is+the+meaning+of+life?
```
