---
'mppx': patch
---

Added request body digest binding. The HTTP transport now captures request body bytes and computes a SHA-256 digest during `captureRequest`. This digest is included in the challenge's HMAC-bound ID, and verified against the current request body when a credential is presented. This prevents replay attacks where a credential issued for one request body is presented with a different body.
