---
'mppx': minor
---

Replaced request attestation with per-route identity. Breaking changes:

- `mppx/attestation` became `mppx/identity`. Server `Mppx.create({ attestation })` was removed (passing it now throws); routes take `identity: [verifier, ...]` (all required), for example `mppx.charge({ amount, identity: [tap] })`, and the result exposes `result.identity.get(verifier)`.
- Added `Identity.anyOf(...)` to accept one of several protocols. Every member runs, so each presented proof is consumed.
- Verifiers return `missing`, `invalid` or `valid` (`unverified` became `invalid` with code 403), may set their own status `code` and `headers`, and declare a `stage`: `request` (checked before any 402) or `payment` (adds headers to the 402 and is checked against the answered challenge and credential before settlement). Identity rejections are returned on the non-200 branch as a 401/403 response.
- A composed route can include at most one offer with payment-stage identity. Payment-stage identity is not supported on methods with a preflight hook.
- Client `attestation` signer maps became `identity: [prover, ...]`. Provers have a required origin `scope`, receive the payment challenge in `prove(request, context)`, and can prepare proofs or request one resend with `retry(response, context)`. Requests that carry proofs do not follow redirects.
- TAP and Web Bot Auth moved to `mppx/extensions/identity/tap` and `mppx/extensions/identity/web-bot-auth`; `Client.signer` became `Client.prover`.
