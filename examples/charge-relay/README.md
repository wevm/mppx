# Hono Charge Relay

A single-file Hono API that accepts pathUSD on Tempo Moderato. Its
`mppx/hono` middleware issues charges, then calls the Tempo API Moderato relay
for validation and broadcast.

## Setup

Create a Tempo API key with the `mpp:write` scope and provide it only to the
server process:

```bash
export TEMPO_API_KEY=tempo:sk:...
export TEMPO_API_URL=https://api.tempo.xyz
export MPP_SECRET_KEY=$(openssl rand -base64 32)
pnpm install
pnpm dev
```

`TEMPO_API_URL` can target a compatible self-hosted or preview Tempo API.
`MPP_SECRET_KEY` protects the server-issued challenges; the example has a
development-only default so it can run without one locally.

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
  // relay: { apiBaseUrl: process.env.TEMPO_API_URL, apiKey: process.env.TEMPO_API_KEY! },
})
```

Uncommenting it lets MPPX issue and bind challenges while the adapter validates
and broadcasts submitted credentials. Relay failures are returned as MPPX
payment failures without exposing Tempo API details.
