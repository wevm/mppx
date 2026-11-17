---
'mppx': patch
---

Added `createAuthHeaders` for x402 facilitators that need an API key, in the shape of `@x402/core`'s `FacilitatorConfig`: `x402.facilitator` accepts `{ url, createAuthHeaders }`, and `x402.createAuthHeaders`, `Facilitator.http(url, { createAuthHeaders })` and `evm.facilitatorPayTo(url, { createAuthHeaders })` authenticate a URL facilitator. A non-2xx facilitator response now throws `Errors.FacilitatorResponseError` (status and truncated body) and reaches the client as a 500 instead of a schema error. Clients with `maxAmount` and no `currencies` allowlist now read decimals and EIP-3009 metadata for assets mppx ships (such as Base USDC) from its registry.
