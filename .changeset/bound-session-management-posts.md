---
'mppx': patch
---

Bounded session management POSTs to 30 seconds so stalled endpoints cannot hold funding waiters indefinitely. Timed-out payments report an unknown outcome and ignore late responses.

Persisted uncertain top-up state in the channel store after dispatched management requests timed out, failed, or were cancelled and blocked new deposits, including from replacement managers. Callers must reconcile the pending transaction against trusted chain state before clearing that state.
