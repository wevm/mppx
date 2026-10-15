---
'mppx': patch
---

Bounded session management POSTs to 30 seconds so stalled endpoints cannot hold funding waiters indefinitely. Timed-out payments report an unknown outcome and ignore late responses.
