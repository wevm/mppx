---
'mppx': patch
---

Paid session requests make fewer store round trips. Validating a voucher credential right before broadcasting it no longer reads the stored channel, since broadcasting checks it again. With `voucherStateMaxAge`, a voucher is checked against the stored channel inside the store update that accepts it, without a separate read. The new `chargeOnAcceptance` option charges request-priced content in that same update instead of a second update when the response is delivered.
