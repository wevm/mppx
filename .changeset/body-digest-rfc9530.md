---
'mppx': patch
---

Accepted the RFC 9530 byte-sequence form (`sha-256=:base64:`) in `BodyDigest.verify`, alongside the existing bare form. `BodyDigest.compute` still emits the bare form.
