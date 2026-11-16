---
'mppx': patch
---

Fixed `tempo.charge` clients so that `maxAmount` and `maxAtomicAmount` cover a Zone payment's withdrawal fee: the amount plus the fee must fit, checked before withdrawing.
