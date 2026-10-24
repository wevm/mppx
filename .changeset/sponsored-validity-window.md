---
'mppx': patch
---

Widened the Tempo charge client's expiring-nonce `validBefore` window from 25 to 60 seconds (still capped at the challenge expiry), leaving room for clock skew against the fee payer's 15-second remaining-validity minimum. Clients now refuse to sign a sponsored challenge that expires in under 15 seconds, and servers refuse to issue one.
