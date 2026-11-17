---
'mppx': minor
---

Added `x402.extra` to `evm.charge` for facilitators that read their own keys in a payment requirement's `extra`, an optional `supported()` on x402 facilitator clients (`GET /supported`, implemented by the HTTP client), and `evm.facilitatorPayTo()` to read the `payTo` a facilitator publishes there as the charge's `recipient`.
