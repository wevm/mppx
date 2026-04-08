---
'mppx': patch
---

Centralize the authoritative challenge verification inputs by adding captured-request and verified-envelope context plumbing, shared canonical HMAC input generation, and a single pinned-request comparison path without changing the existing server hook model.
