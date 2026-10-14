---
'mppx': patch
---

Added `maxAmount` (display units, parsed with `decimals`) and `maxAtomicAmount` (base units) to the `tempo.charge()` client, matching the EVM charge client. Offers that exceed a cap or fail `expectedRecipients`, `expectedChainId`, or `allowedChainIds` are skipped during challenge selection and rejected before signing, and a `maxAmount` that would round is rejected.
