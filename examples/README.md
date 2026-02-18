# mppx Examples

Standalone, runnable examples demonstrating the mppx HTTP 402 payment flow.

## Examples

| Example | Description |
|---------|-------------|
| [charge](./charge/) | Payment-gated image generation API |
| [stripe](./stripe/) | Stripe SPT charge with automatic client |
| [session/multi-fetch](./session/multi-fetch/) | Multiple paid requests over a single payment channel |
| [session/sse](./session/sse/) | Pay-per-token LLM streaming with SSE |

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
