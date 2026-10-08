---
'mppx': patch
---

Changed `tempo/session` to serve charged requests when a scheduled settlement's lease claim, JSON-RPC rate limit, internal RPC error or receipt wait failed transiently; the next settlement collected the charge.
