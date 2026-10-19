---
'mppx': patch
---

Fixed `compose()` dispatching every `tempo/session` credential to the first session handler. Dispatch compared the credential with each handler's route request, which lacks the `chainId` and `sessionProtocol` the session request hook adds, so no handler matched; sessions offered in several currencies rejected all but the first with a currency mismatch.
