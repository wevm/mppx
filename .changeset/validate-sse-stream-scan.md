---
'mppx': patch
---

Fixed `mppx validate` buffering SSE session streams in memory and hanging when the session client cancelled one: in-stream receipts are now read as the client consumes the stream instead of from an unread copy.
