---
'mppx': patch
---

`stripe.create()`: `defaultMethods()` now returns sync SPT-only when no `depositAddresses` is provided, and uses `Promise.allSettled` in the function resolver path to gracefully degrade when individual networks fail.
