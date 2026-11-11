# Human-backed agents with World ID

A paid API for agents approved by a World ID-verified human: each human's first report is free, later ones cost 0.01 pathUSD on Tempo testnet. It uses [World IdP](https://auth.world.org/docs/guides/getting-started), World's OpenID Connect issuer: the server runs the device flow, the person approves in World App, and the server keeps their anonymous, pairwise subject.

## Setup

```bash
npx gitpick wevm/mppx/examples/world-id
pnpm i
```

Register a confidential client at [auth.world.org/portal](https://auth.world.org/portal); for testing, use the sandbox portal and `WORLD_ISSUER=https://sandbox.auth.world.org`. A coding agent can set it up with this prompt:

```
Read https://auth.world.org/docs/guides/coding-agent-setup.md and follow its instructions to integrate World ID into this project.
```

## Usage

```bash
WORLD_CLIENT_ID=... WORLD_CLIENT_SECRET=... pnpm server
pnpm client
```

The client prints an approval link and code. Approve in World App: the first report is free, the second is paid.

## How it works

- [`src/server.ts`](./src/server.ts) checks `World.Server.verifier({ clientId, clientSecret, secretKey, store })`. A request without a session gets 401 with `World-Id-Required: device`.
- [`src/client.ts`](./src/client.ts) passes `World.Client.prover({ scope, verification })` to `Mppx.create()`. On that 401, it asks the server to start a device attempt (`World-Id-Poll: start`), shows the link through `verification`, and polls at the server's interval.
- On approval, the server validates the ID token (RS256 signature, issuer, audience, times, a fresh `auth_time`, and an Orb `acr` by default) and returns a session sealed with `secretKey`. The client sends it in `World-Id` on the retry and later requests until it expires (one hour by default). Device codes and ID tokens stay on the server, and device-flow calls never reach the handler.
- The verified `subject` identifies the human, so the free report is counted per human, not per agent.
