# Stream: WebSocket

Pay-per-token LLM-style streaming over WebSocket using the experimental Tempo session websocket helper. The server is a Cloudflare Worker: it accepts the upgrade with a `WebSocketPair` and hands the socket to `mppx.session.serveWebSocket()`. Channel state lives in Durable Objects through `Store.durableObject()`.

The client performs an HTTP `402` probe, opens a payment channel, upgrades to WebSocket, and then streams tokens while automatically responding to `payment-need-voucher` control frames.

## Setup

```bash
npx gitpick wevm/mppx/examples/session/ws
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
BASE_URL=https://mppx-session-ws.<account>.workers.dev pnpm client
```

## Notes

- The WebSocket flow currently uses HTTP for the initial `402` challenge probe.
- During the stream, vouchers are sent in-band over the socket.
- The prompt is a path segment (`/ws/chat/<prompt>`): payment frames are verified as POSTs to that URL, and a POST with a query string is billed as content.
- After the stream ends, the demo calls `close()` to settle the channel and print the final receipt.
