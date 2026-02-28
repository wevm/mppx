---
"mppx": patch
---

Removed `realm` from `PaymentRequiredError` detail message to avoid leaking deployment URLs and hostnames in error responses.
