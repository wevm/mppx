# Email OTP identity with MPP

A paid API on Cloudflare Workers that only callers with a verified email address may use. The server requires an email attestation before it issues or accepts an MPP payment challenge. The client gets a one-time code by email from the attestation issuer, exchanges it for a signed attestation bound to the server's origin, then pays.

The issuer is [`apps/mpp-identity`](https://github.com/tempoxyz/tempo-apps/tree/main/apps/mpp-identity) in tempoxyz/tempo-apps, a Worker that sends codes with Cloudflare Email Service.

## Setup

```bash
npx gitpick wevm/mppx/examples/email-otp
pnpm i
pnpm keygen   # writes .dev.vars, funds the server account on testnet
```

To use a local issuer instead of the hosted one, run `apps/mpp-identity` with `pnpm dev` (port 8787, codes printed in its log) and run `ISSUER=http://localhost:8787 pnpm keygen`.

## Usage

Start the Worker locally:

```bash
pnpm dev
```

In a separate terminal, run the client and type the code from your inbox (or the local issuer's log):

```bash
EMAIL=you@example.com pnpm client
# or, with a local issuer:
ISSUER=http://localhost:8787 EMAIL=you@example.com pnpm client
```

An unverified request to `/api/report` gets `401` with `Identity-Attestation-Required: email;issuer="…"`. The client verifies the address, retries, gets the `402` challenge, pays 0.01 pathUSD and returns the report with the verified address.

## With curl

The attestation is a header, so any HTTP client can present it:

```bash
ISSUER=https://identity.mpp.tempo.xyz
API=http://localhost:8788

# 1. Email a code for this API's origin.
ID=$(curl -s $ISSUER/email/otp -H 'content-type: application/json' \
  -d "{\"email\":\"you@example.com\",\"audience\":\"$API\"}" | jq -r .id)

# 2. Exchange the code from the email for an attestation.
ATTESTATION=$(curl -s $ISSUER/email/verify -H 'content-type: application/json' \
  -d "{\"id\":\"$ID\",\"code\":\"123456\"}" | jq -r .attestation)

# 3. Call the API with it: 402 instead of 401, then pay as usual.
curl -i $API/api/report -H "Identity-Attestation: $ATTESTATION"
```

## How it works

[`src/server.ts`](./src/server.ts) creates `EmailOtp.Server.verifier({ audience, issuer, allow })` and requires it per route: `mppx.charge({ amount, identity: [email] })`. The verifier checks the attestation's Ed25519 signature against the issuer's `/.well-known/jwks.json`, its issuer, its expiry and that its audience is this server's origin. `allow` applies the route's policy, here an optional domain allowlist. In a handler, `result.identity.get(email)` returns the verified address.

[`src/client.ts`](./src/client.ts) passes `EmailOtp.Client.prover({ email, code, issuers, scope })` to `Mppx.create()`. On a 401 with `Identity-Attestation-Required`, it asks the issuer for a code, calls `code` for it, and retries with the attestation. It only sends the address to the `issuers` it trusts, and it always binds the attestation to the origin it is talking to, so a server cannot obtain one it could replay at another server.

An attestation proves that whoever presents it received a code at that address, until it expires (24 hours by default). It is a bearer proof: keep it like a session token. It says nothing about what the address's owner may do; the server decides that.

## Deploy

```bash
wrangler secret put MPP_PRIVATE_KEY   # from .dev.vars
wrangler secret put MPP_SECRET_KEY    # from .dev.vars
wrangler secret put TEMPO_RPC_URL     # optional: a dedicated Tempo RPC
pnpm deploy
EMAIL=you@example.com BASE_URL=https://mppx-email-otp.<account>.workers.dev pnpm client
```
