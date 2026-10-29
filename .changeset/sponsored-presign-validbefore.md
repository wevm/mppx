---
'mppx': patch
---

Fixed the Tempo charge client signing a sponsored transaction whose `validBefore` had fewer than 15 seconds left after slow preparation: the pre-sign check now measures `validBefore` as well as the challenge expiry.
