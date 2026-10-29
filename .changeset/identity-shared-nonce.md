---
'mppx': minor
---

Simplified payment-stage identity. Breaking changes to `mppx/identity`:

- Every payment offer in one 402 now carries the same HMAC-bound identity nonce, passed to verifiers as `context.nonce`. Bind payment-stage proofs to it instead of the challenge id. Routes may combine several offers with payment-stage identity (for example `tempo()`'s default currencies, or Tempo and Stripe), as long as they require the same verifiers; previously a route allowed only one such offer.
- Verifiers issue their 402 challenge headers through a new optional `challenge(request, { nonce })` hook, which runs once per 402, instead of returning them from `verify` as `missing`. `verify` only checks proofs.
- `Prover.retry` is split: `prepare(response, { challenge })` runs on a 402 before the payment retry, and `retry(response)` runs on other rejections and returns whether to resend.
