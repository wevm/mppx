---
'mppx': patch
---

Added `headers` for x402 facilitators that need an API key: a flat record sent on every request, or an object keyed by `verify`, `settle` and `supported` (the shape `createAuthHeaders` returns in `@x402/core`), or a function returning either. `x402.facilitator` accepts `{ url, headers }`, and `x402.headers`, `Facilitator.http(url, { headers })` and `evm.facilitatorPayTo(url, { headers })` authenticate a URL facilitator. A non-2xx facilitator response now throws `Errors.FacilitatorResponseError` (status and truncated body) and reaches the client as a 500 instead of a schema error. Clients with `maxAmount` and no `currencies` allowlist now read decimals and EIP-3009 metadata for assets mppx ships (such as Base USDC) from its registry.
