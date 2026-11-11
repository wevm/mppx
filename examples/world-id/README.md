# Human-backed agents with World ID

A paid API for agents approved by a World ID-verified human: each human's first report is free, later ones cost 0.01 pathUSD on Tempo testnet. A shared World ID issuer runs [World IdP](https://auth.world.org/docs/guides/getting-started)'s device flow, the person approves in World App, and the issuer signs an `Identity-Attestation` for this server. The server only checks it.

## Setup

```bash
npx gitpick wevm/mppx/examples/world-id
pnpm i
```

## Usage

```bash
WORLD_ID_ISSUER=https://world-id.issuer.example pnpm server
WORLD_ID_ISSUER=https://world-id.issuer.example pnpm client
```

The client prints an approval link and code. Approve in World App: the first report is free, the second is paid.

## How it works

- [`src/server.ts`](./src/server.ts) checks `World.Server.verifier({ audience, issuer })`. A request without an attestation gets 401 with `Identity-Attestation-Required: world-id;issuer="…"`.
- [`src/client.ts`](./src/client.ts) passes `World.Client.prover({ issuers, scope, verification })` to `Mppx.create()`. On that 401, it asks the issuer to start a device attempt for the server's origin, shows the link through `verification`, polls the issuer, and resends the request with the attestation. It reuses the attestation until it expires.
- The verified `issuer` and `subject` identify the human, so the free report is counted per human, not per agent.

## Running a World ID issuer

The issuer is a separate service with this API (see `World.Constants`):

| Route                        | Body           | Answer                                                                                                                     |
| ---------------------------- | -------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `POST /world/device`         | `{ audience }` | `{ id, user_code, verification_uri, verification_uri_complete?, expires_in, interval }`                                    |
| `POST /world/token`          | `{ id }`       | `{ attestation, expires_at }`, or 400 with `error`: `authorization_pending`, `slow_down`, `access_denied`, `expired_token` |
| `GET /.well-known/jwks.json` |                | Its EdDSA attestation keys                                                                                                 |

It signs attestations with `type: 'world-id'`, `aud` set to the requested audience and the World IdP `acr` claim. Running one:

- Register a confidential World IdP client at [auth.world.org/portal](https://auth.world.org/portal). It needs a registered redirect URI even though it only uses the device flow.
- Limit `/world/device` per caller: World IdP limits device starts per client, so one caller could otherwise use up every caller's budget and produce approval links under the issuer's name.
- Verify the ID token (RS256 from World IdP's JWKS, issuer, audience, times, `auth_time`, `acr`, `amr`) before ending the attempt, and keep the last good keys, so a brief JWKS outage doesn't waste an approval: World IdP device codes can be redeemed only once.
- Treat a timeout or network error while polling World IdP as unavailable, and poll again.
- Keep device codes, ID tokens and World's subject on the issuer. Deriving `sub` per audience, such as an HMAC of World's subject and the audience, keeps servers from linking one human across them.
