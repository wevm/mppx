# mpay Examples

Standalone, runnable examples demonstrating the mpay HTTP 402 payment flow.

## Examples

| Example | Description |
|---------|-------------|
| [basic](./basic/) | Vite dev server with pay-per-request fortune API |
| [stream](./stream/) | Streaming payment channels with per-token LLM metering |
| [hono](./hono/) | Minimal Hono server with paid endpoint |
| [express](./express/) | Minimal Express server with paid endpoint |
| [nextjs](./nextjs/) | Next.js App Router with paid API route |

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
npx gitpick wevm/mpay/examples/hono
```
