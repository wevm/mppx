---
'mppx': patch
---

Attached the original error as `cause` on `InternalPaymentError` so payment hooks can inspect unexpected failures, and added `CredentialReplayedError` (a `VerificationFailedError` subclass) for replayed Tempo charge credentials. Problem Details responses were unchanged.
