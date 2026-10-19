---
'mppx': patch
---

Sessions now read on-chain channel state concurrently with the stored channel when accepting a voucher, instead of after it. The forced on-chain refresh and error precedence are unchanged.
