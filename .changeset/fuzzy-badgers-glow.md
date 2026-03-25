---
'mppx': patch
---

Fix two production session/SSE robustness issues.

1. Accept exact voucher replays (`cumulativeAmount == highestVoucherAmount`) as idempotent success after signature verification, while still rejecting lower cumulative amounts and preserving monotonic state advancement rules.
2. Prevent invalid null-body response wrapping in SSE receipt transport by returning `101/204/205/304` responses directly instead of stream-wrapping them.
