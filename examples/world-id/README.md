# Human-backed agents with World ID

A paid API for agents approved by a World ID-verified human: each human's first report is free, later ones cost 0.01 pathUSD on Tempo testnet. A World ID issuer runs [World IdP](https://auth.world.org/docs/guides/getting-started)'s device flow, the person approves in World App, and the issuer signs an `Identity-Attestation` for this server. The server runs the issuer itself (self-hosted) or names a shared one.

## Setup

```bash
npx gitpick wevm/mppx/examples/world-id
pnpm i
```

To self-host the issuer, register a confidential client at [auth.world.org/portal](https://auth.world.org/portal); for testing, use the sandbox portal and `WORLD_ISSUER=https://sandbox.auth.world.org`. The client needs a registered redirect URI even though it only uses the device flow.

## Usage

```bash
# Self-hosted issuer
WORLD_CLIENT_ID=... WORLD_CLIENT_SECRET=... pnpm server
pnpm client

# Shared issuer
WORLD_ID_ISSUER=https://world-id.issuer.example pnpm server
WORLD_ID_ISSUER=https://world-id.issuer.example pnpm client
```

The client prints an approval link and code. Approve in World App: the first report is free, the second is paid.

## How it works

- [`src/server.ts`](./src/server.ts) checks `World.Server.verifier({ audience, issuer })`. A request without an attestation gets 401 with `Identity-Attestation-Required: world-id;issuer="…"`. Self-hosted, it also runs `World.Issuer.create()` and answers its routes with `issuer.handle(request)`, and the verifier resolves the key in process with `issuer.keyResolver`.
- [`src/client.ts`](./src/client.ts) passes `World.Client.prover({ issuers, scope, verification })` to `Mppx.create()`. On that 401, it asks the issuer to start a device attempt for the server's origin, shows the link through `verification`, polls the issuer, and resends the request with the attestation. It reuses the attestation until it expires.
- The verified `issuer` and `subject` identify the human, so the free report is counted per human, not per agent. Subjects are pairwise by default: each server sees a different one for the same human.

## Running a World ID issuer

`World.Issuer.create()` runs the same issuer as a shared service or inside an app. It answers these routes, relative to its `url`:

| Route                        | Body           | Answer                                                                                                                     |
| ---------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POST /world/device`         | `{ audience }` | `{ id, user_code, verification_uri, verification_uri_complete?, expires_in, interval }`                                    |
| `POST /world/token`          | `{ id }`       | `{ attestation, expires_at }`, or 400 with `error`: `authorization_pending`, `slow_down`, `access_denied`, `expired_token` |
| `GET /.well-known/jwks.json` |                | Its EdDSA attestation keys                                                                                                 |

- **Who may start an attempt:** World IdP limits device starts per client, so set `authorize` (such as the app's signed-in users) or `limit` (per caller). A shared issuer can't see a buyer's session, so it relies on `limit`.
- **Audiences:** set `audiences` to the origins it attests for; self-hosted, the app's own origin.
- **State:** attempts and their poll schedules live in `store`; share one atomic store across instances.
- **Approvals survive outages:** an approval's ID token is kept until it verifies, and World IdP's last good keys keep verifying through a JWKS outage, so the human never approves twice. A World IdP timeout answers 503, and the client polls again.
