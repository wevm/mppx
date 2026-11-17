---
'mppx': patch
---

Added `extensions` to `Receipt` and to the result of `evm.charge`'s `settle` so a server reads the `extensions` an x402 facilitator returns from `/settle`, and forwarded them unchanged in the x402 `PAYMENT-RESPONSE` header. Fixed the HTTP facilitator client rejecting `/verify` and `/settle` responses whose `extensions` values aren't `{ info, schema }` declarations.
