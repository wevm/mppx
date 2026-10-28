---
'mppx': patch
---

Added optional `summary` and `requestBody` to proxy endpoint definitions, emitted in the proxy's generated `/openapi.json`. Free routes can carry them as `{ free: true, summary, requestBody }`. An endpoint that is neither a payment handler, `true` nor `{ free: true }` (such as `{ pay: undefined }`) now fails closed with an error instead of being proxied.
