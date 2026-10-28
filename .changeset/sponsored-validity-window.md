---
'mppx': patch
---

Widened the Tempo charge client's expiring-nonce `validBefore` window from 25 to 30 seconds (still capped at the challenge expiry), leaving room for clock skew against the fee payer's 15-second remaining-validity minimum. Clients refused to sign a sponsored pull transaction for a challenge expiring in under 15 seconds, checking again right before signing, and servers refused to issue a sponsored challenge with a paid amount and pull mode that expires that soon. Request hooks received the expiry echoed by the credential when verifying it.
