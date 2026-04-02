---
'mppx': patch
---

Bind attribution memo nonce to challenge ID. The 7-byte nonce field (bytes 25–31) is now derived from `keccak256(challengeId)[0..6]` instead of random bytes, preventing transaction hash stealing in push mode. `Attribution.encode()` now requires `challengeId`. The server verifies challenge binding and server fingerprint for `hash` (push) credentials. Pull-mode `transaction` credentials are not affected — the server controls broadcast, so there is no hash-stealing risk.

**Breaking:** `Attribution.encode()` now requires `challengeId` — callers must pass the challenge ID to generate a memo. Old push-mode clients that generate random attribution nonces or plain transfers without memos are rejected by the server. Pull-mode clients are unaffected.
