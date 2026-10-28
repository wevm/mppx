---
'mppx': patch
---

Fixed multi-method intent handlers rejecting every route option but `identity` when the methods' options can't be inferred, such as `mppx.charge({ amount })` with `stripe.create(...).defaultMethods()`.
