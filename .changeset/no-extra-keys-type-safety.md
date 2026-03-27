---
'mppx': patch
---

Added compile-time guard to `tempo.session()` and `tempo.charge()`. Unknown properties (e.g. `stream` instead of `sse`) now cause a type error instead of being silently accepted.
