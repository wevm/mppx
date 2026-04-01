---
'mppx': patch
---

Hardened credential verification, transport billing, error responses, and proxy routing. Credential request binding now verifies fields match the actual incoming request. SSE transport derives billing context directly from the verified credential payload. 402 error responses no longer leak internal details. Proxy routing binds management POST fallback to the credential's payment method and intent for correct disambiguation.
