# Stream: SSE

Pay-per-token LLM streaming using the SSE handler API. The server uses `tempo.Sse.from()` to create an SSE response that charges per token via `stream.charge()`. The client uses `session.sse()` to consume tokens as an async iterable, automatically handling voucher top-ups and receipts.

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
