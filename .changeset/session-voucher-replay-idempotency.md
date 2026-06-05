---
'mppx': patch
---

Fixed `tempo.session` voucher verification to treat lower-amount voucher replays idempotently. Per the session spec's idempotency requirement, a non-advancing voucher (with a `cumulativeAmount` at or below the highest accepted amount, but above the on-chain settled amount) now returns a 200 OK receipt with the current highest amount instead of being rejected as an error. Forged or at-or-below-settled vouchers are still rejected, and the at-or-below-settled rejection reason was clarified to match the inclusive (`<=`) bound.
