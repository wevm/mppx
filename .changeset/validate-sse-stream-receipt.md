---
'mppx': patch
---

Fixed `mppx validate` failing valid SSE sessions: the in-stream `payment-receipt` event is now read from the server's own stream, which the session client strips, and lone-CR line endings are accepted.
