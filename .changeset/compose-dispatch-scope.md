---
'mppx': patch
---

Fixed `compose()` dispatch for handlers without a static `scope`. Their challenges are scoped to the request's route, so dispatch now compares the credential's metadata with that scope merged in, instead of falling back to the first handler with the same method and intent.
