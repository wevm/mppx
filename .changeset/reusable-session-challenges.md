---
'mppx': patch
---

Added `reusableChallenges` to `tempo.session()`. A session challenge then stays valid for later requests to the same route until it expires: it is bound to its route, currency, recipient and channel terms but not to the amount it quoted, and every request is charged its own price from the channel's accepted balance. Clients can send a voucher with a request instead of waiting for a `402`. Composed handlers with a stable binding are now also dispatched by the fields their route request defines.
