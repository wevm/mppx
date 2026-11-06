---
'mppx': patch
---

Improved the internal SSE parser's throughput on line-dense `text/event-stream` bodies by scanning with `indexOf` instead of a global RegExp.
