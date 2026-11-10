---
'mppx': minor
---

Added `Errors.ChallengeUnpayableError` for offers a client cannot pay before anything is signed or sent. When a challenge fails this way, `fetch` tries the next offered challenge from the same response instead of failing. Tempo charges in pull mode and session transactions report a reverted pre-signing simulation, such as for a missing balance, and an autoswap with no route as this error, so a client holding only one of several offered currencies pays with it.
