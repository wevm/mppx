---
'mppx': patch
---

Attached the original error as `cause` on `InternalPaymentError` so payment hooks can inspect unexpected failures, and added `CredentialReplayedError` (a `VerificationFailedError` subclass) for Tempo charge credentials whose payment already settled: replayed transaction hashes and proofs, claims held by a concurrent request, and settled transfers whose memo is bound to another challenge. The HTTP transport and session bootstrap answer it with a final 403 Problem Details response without a `WWW-Authenticate` challenge, so clients do not pay again; the problem type stays `verification-failed`.
