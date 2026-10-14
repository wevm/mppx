---
'mppx': patch
---

Released Tempo charge transaction hash claims when settlement fails after a broadcast attempt, so retrying the same credential re-broadcasts and recovers the receipt instead of being rejected as a replay.
