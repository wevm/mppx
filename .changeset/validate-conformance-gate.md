---
'mppx': patch
---

Fixed `mppx validate` and paid CLI retries rejecting every mppx server's retry Challenge as changed: the comparison now ignores the per-issuance `_mppx_nonce` and `_mppx_identity` in `opaque`. The malformed-Credential probe now sends the `-H` headers and puts the Credential in the header the server's Challenge names.
