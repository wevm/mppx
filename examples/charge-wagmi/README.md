# Charge: Wagmi

A React page that pays per photo from a connected wallet (passkey or MetaMask) with Wagmi, and the payment-gated photo API it calls, on Cloudflare Workers. `vite dev` serves the page and runs the Worker (`server.ts`) in workerd. Used payments are recorded in Durable Objects through `Store.durableObject()`.

## Setup

```bash
npx gitpick wevm/mppx/examples/charge-wagmi
pnpm i
pnpm keygen   # writes .dev.vars and funds the server account on testnet
```

## Usage

Start the page and the Worker locally:

```bash
pnpm dev
```

Open http://localhost:8787, connect a wallet and generate a photo. The page funds a new wallet from the testnet faucet and pays 0.01 per photo.

## Deploy

```bash
wrangler secret put MPP_PRIVATE_KEY   # from .dev.vars
wrangler secret put MPP_SECRET_KEY    # from .dev.vars
wrangler secret put TEMPO_RPC_URL     # optional: a dedicated Tempo RPC
pnpm deploy
```
