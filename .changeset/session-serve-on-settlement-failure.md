---
'mppx': minor
---

Changed failed scheduled `tempo/session` settlements to serve the charged request when the failure is retryable; the charge stays for the next settlement. Verification failures, such as a revert, still fail the request.
