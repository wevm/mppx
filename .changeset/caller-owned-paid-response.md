---
'mppx': minor
---

Added an optional caller-owned `validateResponse` hook and detached `PaidResponse` view so paid application output can be rejected after settlement without retrying payment or dropping receipt evidence.
