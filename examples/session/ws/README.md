# Stream: WebSocket

Pay-per-token LLM-style streaming over WebSocket using the experimental Tempo session websocket helper.

The client performs an HTTP `402` probe, opens a payment channel, upgrades to WebSocket, and then streams tokens while automatically responding to `payment-need-voucher` control frames.

## Setup

```bash
npx gitpick wevm/mppx/examples/session/ws
pnpm i
```

For local demos from this repository, use the workspace version instead:

```bash
pnpm install
pnpm dev:example
```

Then choose `session/ws`.

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

## Notes

- The WebSocket flow currently uses HTTP for the initial `402` challenge probe.
- During the stream, vouchers are sent in-band over the socket.
- After the stream ends, the demo calls `close()` to settle the channel and print the final receipt.
