---
'mppx': patch
---

Fixed `Poppy.Server.verifier` so a failed key reload keeps the agent's previously loaded keys instead of answering `unavailable` until the next reload.
