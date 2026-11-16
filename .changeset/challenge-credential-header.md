---
'mppx': patch
---

Changed challenges to accept only `Payment-Authorization` as an explicit `header`: clients skip a received challenge that names any other credential header, and servers throw when configured with one (`Authorization` still means the default).
