---
'mppx': patch
---

Fixed the Tempo charge client to never pay by push (hash or Zone) for a challenge whose request sets `methodDetails.memo`, which servers must reject; it pays by pull instead, or refuses a push-only challenge without paying.
