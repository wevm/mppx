---
"mppx": patch
---

Removed `expires` from charge request schemas (tempo, stripe). Expiry is now conveyed exclusively via the `expires` auth-param on the Challenge, not duplicated in the request body. Server handlers default to `Expires.minutes(5)` when `expires` is not explicitly provided.
