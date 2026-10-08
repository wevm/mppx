---
'mppx': patch
---

Changed `tempo/session` to serve a charged request when its scheduled settlement hit a transport or RPC failure; the next settlement collected the charge. Reverts and configuration errors still failed the request.
