---
'mppx': patch
---

Enforced the fee payer's 15-second remaining-validity minimum for Tempo charges: clients refused to sign a sponsored pull transaction for a challenge expiring in under 15 seconds, checking again right before signing, and servers refused to issue a sponsored challenge with a paid amount and pull mode that expires that soon. Push and zero-amount challenges were exempt. Request hooks received the expiry echoed by the credential when verifying it.
