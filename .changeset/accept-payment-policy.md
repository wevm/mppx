---
'mppx': patch
---

Added `acceptPaymentPolicy` option to control when the `Accept-Payment` header is injected on outgoing requests, mitigating CORS preflight failures on non-payment-aware servers.

- `Fetch.polyfill` and `Mppx.create` (with `polyfill: true`) default to `'same-origin'`, preventing cross-origin CORS issues.
- `Mppx.create` with `polyfill: false` defaults to `'always'`.
