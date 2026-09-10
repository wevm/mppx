---
'mppx': minor
---

Enforced recipient allowlists for both primary and split recipients, including zero-amount proofs.

Migration: include the primary recipient address as well as every split recipient in `expectedRecipients`. Configurations containing only split recipients are now rejected.
