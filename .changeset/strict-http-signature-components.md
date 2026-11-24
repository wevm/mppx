---
'mppx': patch
---

Rejected HTTP message signatures that cover a component twice or cover `@signature-params`, as RFC 9421 requires. Web Bot Auth verification now rejects algorithms its profile does not support before resolving a key.
