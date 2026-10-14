---
'mppx': patch
---

Shared default sponsor-budget storage across currency offers from tempo.charge and tempo.common, enforcing aggregate exposure limits without changing replay-store policy. Multi-process deployments still require a shared atomic store.
