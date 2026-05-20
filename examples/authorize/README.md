# Authorize Playground

Deferred capture playground for Tempo authorizations.

The app opens real TIP-1034 authorize channels through the HTTP 402 flow. The table then lets the server capture partial chunks, capture and close, or void the authorization.

## Usage

The default target is a local Tempo dev container:

```bash
pnpm dev
```

Override the RPC if your container exposes a different port:

```bash
MPPX_RPC_URL=http://localhost:7545/1 pnpm dev
```

To point at hosted networks instead:

```bash
MPPX_NETWORK=devnet pnpm dev
MPPX_NETWORK=testnet pnpm dev
```

Optional environment:

```bash
MPPX_AUTHORIZE_CURRENCY=0x20c0000000000000000000000000000000000001
MPPX_SERVER_PRIVATE_KEY=0x...
```
