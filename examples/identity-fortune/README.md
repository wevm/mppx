# Identity Fortune

A paid haiku API that gets cheaper and more personal the more the caller proves, with a page that shows every part running: a live diagram, the real source with the running line highlighted, and every HTTP hop.

| Tier      | Client plugs in                          | Price        | The haiku knows    |
| --------- | ---------------------------------------- | ------------ | ------------------ |
| anonymous | nothing                                  | 0.03 pathUSD | nothing            |
| email     | `EmailOtp.Client.prover`                 | 0.02 pathUSD | first name, domain |
| member    | a member API key, or an @tempo.xyz email | 0.01 pathUSD | name, team, role   |

The Worker hosts the paid API, a minimal email issuer (`/issuer`, the same protocol as [`apps/mpp-identity`](https://github.com/tempoxyz/tempo-apps/tree/main/apps/mpp-identity), signing with `Attestation.sign`), and the page. Workers AI writes the haiku.

## Setup

```bash
pnpm i
pnpm keygen   # writes .dev.vars and funds the payee account on testnet
pnpm dev      # http://localhost:8790
```

Without a Cloudflare login, Workers AI is unavailable locally: set `ANTHROPIC_API_KEY` in `.dev.vars` to use Claude Haiku instead, or the Worker uses a built-in haiku. Without an `EMAIL` binding, codes go to a demo inbox the page shows.

## With curl

```bash
API=http://localhost:8790

# Anyone: 402 at 0.03, with the upgrades on offer.
curl -i $API/api/fortune

# Ask for the email tier: 401 Identity-Attestation-Required: email;issuer="$API/issuer".
curl -i "$API/api/fortune?tier=email"

# Get a code, then an attestation.
ID=$(curl -s $API/issuer/email/otp -H 'content-type: application/json' \
  -d "{\"email\":\"you@example.com\",\"audience\":\"$API\"}" | jq -r .id)
curl -s $API/api/inbox/$ID   # demo inbox only
ATTESTATION=$(curl -s $API/issuer/email/verify -H 'content-type: application/json' \
  -d "{\"id\":\"$ID\",\"code\":\"<code>\"}" | jq -r .attestation)

# 402 at 0.02 now; pay it with any MPP client, such as:
npx mppx "$API/api/fortune?tier=email" -H "Identity-Attestation: $ATTESTATION"

# Members skip email entirely:
npx mppx "$API/api/fortune?tier=member" -H 'X-Api-Key: fortune-demo-key'
```

## Deploy

```bash
wrangler secret put MPP_PRIVATE_KEY
wrangler secret put MPP_SECRET_KEY
wrangler secret put ISSUER_PRIVATE_KEY
pnpm deploy
```

To send real email, add a `send_email` binding named `EMAIL` and an `EMAIL_FROM` var for a domain onboarded to Cloudflare Email Service.
