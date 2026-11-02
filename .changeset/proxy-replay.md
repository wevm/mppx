---
'mppx': patch
---

Added an opt-in `replay` option to `Proxy.create`, so a payer who loses the connection during a long paid request can collect the response. The paid upstream request runs detached from the client, and a retry with the same credential and request gets the stored response, `202` while it runs, or a new upstream attempt after a failed delivery, without paying again.
