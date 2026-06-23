---
'mppx': minor
---

Settled MCP-over-HTTP payment challenges in the same payment-aware fetch as HTTP `402`s, so `Transport.http()` can extract JSON-RPC `-32042` challenges and retry with credentials in MCP metadata.
