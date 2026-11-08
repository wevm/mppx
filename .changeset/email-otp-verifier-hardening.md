---
'mppx': patch
---

Fixed the email OTP verifier so a forged attestation with a later expiry no longer hides a valid one, and a key rotated in during an issuer outage answers 503 instead of 401.
