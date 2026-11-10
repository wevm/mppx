# Hono Charge Relay

A single-file Hono API on Cloudflare Workers that accepts pathUSD on Tempo
Moderato. Its `mppx/hono` middleware issues charges, then calls the Tempo API
Moderato relay for validation and broadcast.

## Setup

Create a Tempo API key with the `mpp:write` scope, then:

```bash
npx gitpick wevm/mppx/examples/charge-relay
pnpm i
TEMPO_API_KEY=tempo:sk:... pnpm keygen   # writes .dev.vars
```

`pnpm keygen` writes the payee key (`MPP_PRIVATE_KEY`), the secret that
protects server-issued challenges (`MPP_SECRET_KEY`) and `TEMPO_API_KEY` to
`.dev.vars`, which only the Worker reads. Add `TEMPO_API_URL=...` there to
target a compatible self-hosted or preview Tempo API.

## Usage

Start the Worker locally:

```bash
pnpm dev
```

With the server running, use the `mppx` CLI to make a paid request:

```bash
pnpm mppx localhost:8787/api/photo
```

## Routes

| Route         | Description             |
| ------------- | ----------------------- |
| `/api/photo`  | Payment-gated image URL |
| `/api/health` | Free health check       |

## Flow

1. The server returns a `tempo/charge` pull challenge for pathUSD.
2. The payer signs a Tempo transaction and returns the MPP credential.
3. The local relay hooks call `POST /v1/mpp/validate`, then `POST /v1/mpp/broadcast`.
4. The relay receipt becomes the `Payment-Receipt` response header.

## Relay configuration

The source includes a commented `relay` option showing how to replace the
local relay hooks with the Tempo server adapter:

```ts
const method = tempo.charge({
  currency,
  recipient: account.address,
  relay: { apiBaseUrl: env.TEMPO_API_URL, apiKey: env.TEMPO_API_KEY },
  supportedModes: ['pull'],
})
```

Uncommenting it lets MPPX issue and bind challenges while the adapter delegates
validation and finalization to the relay. The relay broadcasts pull credentials;
for push credentials, it recognizes the already-broadcast transaction and
returns its receipt without sending it again. Relay failures are returned as
MPPX payment failures without exposing Tempo API details.

The adapter derives broadcast ownership from the submitted credential, so a
single relay-backed charge may safely advertise both `pull` and `push` modes.

## Deploy

```bash
wrangler secret put MPP_PRIVATE_KEY   # from .dev.vars
wrangler secret put MPP_SECRET_KEY    # from .dev.vars
wrangler secret put TEMPO_API_KEY
wrangler secret put TEMPO_API_URL     # optional
wrangler secret put TEMPO_RPC_URL     # optional: a dedicated Tempo RPC
pnpm deploy
```
