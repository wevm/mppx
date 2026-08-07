---
'mppx': patch
---

Multi-method intent handler: `.charge()` now works when multiple methods share an intent, internally composing all matching methods into one handler that respects `selectOffers`.
