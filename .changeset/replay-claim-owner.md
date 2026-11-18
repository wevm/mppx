---
'mppx': patch
---

Fixed stale payment cleanup removing a newer replay claim. Custom stores with optimized replay claims now require atomic owner-aware cleanup before Tempo charge can use them.
