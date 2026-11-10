---
'mppx': patch
---

Added `mppx/extensions/identity/link`: server verifiers and client provers for Link agent identity attestations and Link-signed claims, such as a verified email. Added `Identity.Verifier.authorization`, which makes a route refuse a server without `requiresAuth: true`, and stopped proxies from forwarding `Identity-Presentation` headers and upstream identity challenges.
