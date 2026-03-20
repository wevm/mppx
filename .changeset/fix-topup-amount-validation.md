---
"mppx": patch
---

Skip route amount/currency/recipient validation for topUp credentials. The topUp POST carries no application body so the route's request hook may produce a different amount than the challenge echoed from HEAD. The on-chain transaction is the real validation.
