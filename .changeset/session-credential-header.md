---
'mppx': patch
---

Fixed Tempo session top-up, voucher retry, close and bootstrap requests to send the credential in the header the challenge selects (such as `Payment-Authorization` with `requiresAuth`) instead of always using `Authorization`. These requests keep the paid request's own `Authorization` header and no longer follow redirects, so the credential can't reach another origin.
