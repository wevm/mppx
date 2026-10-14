---
'mppx': patch
---

Removed retained native response bodies from manual payment event snapshots to prevent unbounded buffering while callers consume streams. Status and headers remained available; non-HTTP transport snapshots were unchanged.
