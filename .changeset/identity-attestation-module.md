---
'mppx': patch
---

Added `mppx/extensions/identity/attestation` and rebuilt the identity extensions on fixed statuses.

- Added the attestation module (`Attestation` from `mppx/extensions/identity`): `Attestation.Server.verifier` for any attestation type, `Attestation.Client.prover`, `Attestation.sign`, `decode` and `verify` for issuers, `Attestation.Jwks.resolver` and `Attestation.Constants`. The attestation wire format and the `Identity-Attestation` and `Identity-Attestation-Required` headers are unchanged.
- Rebuilt `EmailOtp` on it, with the same public API. Deprecated `EmailOtp.Constants.header` and `requiredHeader` in favor of `Attestation.Constants`.
- Added `Identity.Headers`, the identity request headers that never cross origins or reach upstream and the identity response headers a proxy drops, and `Prover.headers` for a prover's own sensitive request headers. The client's cross-origin redirect stripping and the proxy now read them instead of hardcoded names.
- Added a second `Prover.retry` parameter, `{ request }`: the request that got the rejected response.
- Simplified the attestation prover: it caches one attestation per audience, issuer and type, sends every unexpired one on a paid attempt and only those outside the refresh margin (`min(300s, half the lifetime)`) on an unpaid one, and its `retry` returns the attestations to resend with. Fixed a paid retry dropping an attestation close to expiry, and a late 401 on a concurrent request discarding a just-obtained attestation and asking for another code.
- Moved the identity extensions to fixed statuses: an untrusted or unresolvable signature key and an attestation the route's policy rejects are `forbidden` (403), an unreachable issuer key set is `unavailable` (503). `Attestation.verify` returns `unavailable` instead of `invalid` with `unavailable: true`.
- Deprecated the function form of `audience` in `Attestation.Server.verifier` and `EmailOtp.Server.verifier`: it is only safe where the platform guarantees the request's host.
