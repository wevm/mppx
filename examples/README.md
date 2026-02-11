# mpay Examples

Standalone, runnable examples demonstrating the mpay HTTP 402 payment flow.

## Examples

| Example | Description |
|---------|-------------|
| [basic](./basic/) | Bun server with pay-per-request fortune API |
| [stream](./stream/) | Streaming payment channels with per-token LLM metering |
| [streaming/single-fetch](./streaming/single-fetch/) | Single paid request over a payment channel |
| [streaming/multi-fetch](./streaming/multi-fetch/) | Multiple paid requests on a single channel |
| [streaming/sse](./streaming/sse/) | Pay-per-token SSE streaming with `Sse.from()` |

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
npx gitpick wevm/mpay/examples/basic
```
