# Next.js Example

Minimal mpay integration with [Next.js](https://nextjs.org/) App Router.

The paid API route is just **21 lines** — Next.js route handlers use standard `Request`/`Response`, which maps directly to mpay's API.

## Setup

```bash
cp .env.example .env.local
# Add a private key to .env.local
```

## Run

```bash
# Terminal 1: Start server
pnpm dev

# Terminal 2: Run client
pnpm client
```
