---
'mppx': patch
---

Removed the `eventsource-parser` dependency. The MCP client protocol now reads the first event of a `text/event-stream` response with a small internal SSE parser.
