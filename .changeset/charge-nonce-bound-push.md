---
'mppx': patch
---

Changed Tempo charge to reject push (hash, Zone) and proof credentials for a challenge issued without a per-issuance nonce (challengeNonce: false); only pull (transaction) credentials are accepted then. Kept a settled payment when deleting its broadcast record fails, and answered a body digest mismatch with the problem instead of the payment page.
