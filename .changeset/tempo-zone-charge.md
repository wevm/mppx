---
'mppx': patch
---

Added Zone payments to the `tempo` charge method. A server lists the Zones it accepts with `zones`, a client pays from a Zone balance with `zone`, and the new `zone` credential is verified from the Zone withdrawal that settles the payment on Tempo, with its challenge-bound memo.
