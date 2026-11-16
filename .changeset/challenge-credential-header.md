---
'mppx': patch
---

Changed challenges to accept only `Payment-Authorization` (any case) as an explicit `header`, keeping the received spelling so credentials echo it unchanged; clients skip a challenge that names any other credential header. Servers now throw when configured with another header (`Authorization` still means the default).
