---
'mppx': patch
---

Added `maxAmount` (display units, parsed with `decimals`) and `maxAtomicAmount` (base units) to the `tempo.charge()` client, matching the EVM charge client, to reject challenges above the cap before signing.
