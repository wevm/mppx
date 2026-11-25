---
'mppx': patch
---

Stripped `Forwarded`, `X-Real-IP`, `True-Client-IP`, `CF-Connecting-IP` and `Via` from proxied requests, as `X-Forwarded-*` already is.
