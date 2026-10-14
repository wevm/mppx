---
'mppx': patch
---

Added `maxAmount` (display units, parsed with `decimals`) and `maxAtomicAmount` (base units) to the `tempo.charge()` client, matching the EVM charge client. Over-cap offers are skipped during challenge selection and rejected before signing, and a `maxAmount` that would round is rejected.
