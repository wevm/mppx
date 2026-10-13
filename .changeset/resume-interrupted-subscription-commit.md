---
'mppx': patch
---

Resumed a subscription activation whose commit a crash interrupted, instead of locking the lookup key forever. The created subscription is now persisted with the `committingAt` marker, and once the marker is older than a new `activationRecoveryTimeoutMs` (default 15m) a later activation finishes the commit from the stored record without re-running `create()`, so the period is not charged twice.
