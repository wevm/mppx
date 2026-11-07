---
'mppx': patch
---

Added `Identity.from` and `Identity.Rejection` to `mppx/identity`: `Identity.from({ verify })` turns a function, such as a lookup in your own database, session store or KYC provider, into a route identity verifier. It returns the caller's identity, `undefined` for a 401, or throws `Identity.Rejection` to reject the request before any payment.
