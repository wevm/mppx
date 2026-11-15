---
'mppx': patch
---

Hardened `Poppy.Server.verifier`: it rejects invalid `clients` and `maxAge` config, returns `unavailable` instead of throwing on a malformed key set and `invalid` on a non-object `cnf.jwk`, caches a failed key load for 30 seconds, reloads keys once for an unknown `kid` after 30 seconds, only verifies delegations with signing keys that match their `kid` and `alg`, and rejects `Authorization` values that combine an access token with other credentials. `Poppy-Session` is now an `Identity.Headers.request` header, so the proxy no longer forwards it upstream.
