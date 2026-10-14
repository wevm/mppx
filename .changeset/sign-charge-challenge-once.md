---
'mppx': patch
---

Signed each Tempo charge challenge at most once per signer. Repeated and concurrent requests for the same challenge now reuse one credential until its transaction's `validBefore` passes.
