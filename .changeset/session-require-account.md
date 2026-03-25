---
'mppx': patch
---

`tempo.session()` now throws immediately at initialization if no viem `Account` is provided, instead of failing later with an opaque error during channel close. The error message includes an example fix.
