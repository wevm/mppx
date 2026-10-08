---
'mppx': patch
---

Fixed `tempo/charge` releasing another request's replay marker when a transaction's final hash collided with an already-claimed hash, which let a settled transaction pass replay protection again.
