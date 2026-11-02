---
'mppx': patch
---

Bound each session manager to its first HTTP origin and persisted that binding with reusable channels. Rejected cross-origin HTTP, SSE, and WebSocket reuse before disclosing channel hints or payment credentials, and prevented redirects from forwarding session requests. Existing unbound channel entries acquired an origin on their next validated reuse.
