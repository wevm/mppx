---
'mppx': patch
---

Fixed implicit and explicit composition to preserve each configured method's identity, currency defaults, and offer order. Limited per-method payment success hooks to the method that handled the payment and updated vulnerable transitive dependencies.
