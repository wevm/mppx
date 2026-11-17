---
'mppx': patch
---

Fixed `tempo.charge` servers accepting a Zone withdrawal's settlement as a `hash` Credential as well as a `zone` Credential. A transfer sent by a Zone portal now counts only through its `zone` Credential, so one settlement pays once.
