---
'mppx': minor
---

Reworked identity verification around explicit statuses and data.

- Changed `Identity.Verification` to fixed statuses: `valid`, `missing` (401), `invalid` (401), `forbidden` (403) and `unavailable` (503), exported as `Identity.Status.codes` with the precedence list `Identity.Status.precedence`. When several verifiers (or every `anyOf` member) reject, the status with the highest precedence decides, and the headers of every rejection are merged. **Breaking:** `missing` now answers 401 instead of 403.
- Added `status` to `Identity.Rejection` (`invalid`, `forbidden` or `unavailable`).
- Marked identity rejections with a `rejection` field (`{ stage, status, reason }`) on the route result's non-200 branch, which `compose` now reads.
- Replaced payment-stage verifiers with an experimental payment check, `identity: { request, payment }`: `payment.requires` is listed in every 402's new `Identity-Required` header (merged across composed offers), and `payment.verify` runs once on the paid retry with the Credential. **Breaking:** `stage: 'payment'` verifiers now throw, the identity nonce is no longer added to Challenges, and request verifiers' `verify` receives only the request.
- Changed `Prover.prepare` to receive the selected Challenge and the parsed `Identity-Required` requirements, and `Prover.retry` to return headers to resend with.
- Deprecated `Verifier.stage`, `Verifier.challenge`, the `code` of `missing` and `invalid` outcomes and `Identity.Rejection`'s `code`, and a `retry` result of `true`. They keep working.
