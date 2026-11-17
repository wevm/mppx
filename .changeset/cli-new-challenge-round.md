---
'mppx': patch
---

The CLI now pays a new challenge when a server answers a credential with a 402 that offers one, such as the real charge after a zero-amount proof from a wallet without credit, instead of failing with `PAYMENT_REJECTED`. It takes at most 3 rounds and never answers the same challenge twice, as the client's fetch does.
