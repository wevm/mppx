---
'mppx': patch
---

Added `acceptPaymentPolicy` option to control when the `Accept-Payment` header is injected on outgoing requests, mitigating CORS preflight failures on non-payment-aware servers.

- In browsers, `Fetch.polyfill` and `Mppx.create` (with `polyfill: true`) default to `'same-origin'`, preventing cross-origin CORS issues.
- Non-browser environments and `Mppx.create` with `polyfill: false` default to `'always'`.
- Supported values: `'always'`, `'same-origin'`, `'never'`, `{ origins: string[] }` (with `*.` wildcard support).
- Exported `Fetch` namespace from `mppx/client`.
