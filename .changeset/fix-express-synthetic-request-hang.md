---
'mppx': patch
---

Fixed Express middleware hanging by constructing a Fetch `Request` directly from Express's `req` API.
