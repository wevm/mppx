---
'mppx': patch
---

Refuse to sign an automatic zero-amount Tempo proof when its challenge realm differs from the HTTP server hostname. Clients talking to servers whose realm is not their hostname can allow it with `trustedRealms`.
