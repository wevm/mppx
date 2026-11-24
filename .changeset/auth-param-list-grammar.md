---
'mppx': patch
---

Fixed `Challenge.deserialize` to reject auth-params that are not separated by commas, text after a quoted value, and unquoted values that are not tokens.
