# mppx Examples

Standalone, runnable examples demonstrating the mppx HTTP 402 payment flow.

Each server is a Cloudflare Worker: `pnpm dev` runs it locally in workerd, the Workers runtime, through `@cloudflare/vite-plugin`, with Durable Objects for shared state (channels, replay protection, subscriptions), and `pnpm deploy` ships it. [x402-express](./x402-express/) stays on Node because it demonstrates the Express middleware. Run `pnpm keygen` first in examples that have it.

## Examples

| Example                                       | Description                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------- |
| [charge](./charge/)                           | Payment-gated image generation API                                          |
| [charge-relay](./charge-relay/)               | Hono API settled by the Tempo API relay                                     |
| [session/multi-fetch](./session/multi-fetch/) | Multiple paid requests over a single payment channel                        |
| [session/top-up](./session/top-up/)           | Prepaid API on Cloudflare Workers with automatic and manual channel top-ups |
| [session/sse](./session/sse/)                 | Pay-per-token LLM streaming with SSE                                        |
| [session/ws](./session/ws/)                   | Pay-per-token LLM streaming with WebSocket                                  |
| [stripe](./stripe/)                           | Stripe SPT charge with automatic client                                     |
| [subscription](./subscription/)               | Daily news subscription using Tempo access keys                             |
| [email-otp](./email-otp/)                     | Email OTP identity attestation before an MPP payment                        |
| [identity-fortune](./identity-fortune/)       | Identity tiers on one paid route, with a live view of every step            |
| [web-bot-auth](./web-bot-auth/)               | Web Bot Auth with automatic MPP payment retry                               |
| [x402-mpp](./x402-mpp/)                       | Server route supporting x402 and mpp payments                               |

## Running Examples

From the repository root:

```bash
pnpm install
pnpm dev:example
```

This will show a picker to select which example to run.

## Installing via gitpick

You can install any example directly into your project:

```bash
npx gitpick wevm/mppx/examples/charge
```
