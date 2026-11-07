---
'mppx': patch
---

Fixed `ChannelStore` giving up on a channel during the server's cooperative-close marker, which left a payer close request merged into it unsent, and spending watchdog attempts on alarms set for a close marker that a failed close then cleared. `ChannelStore` now rejects non-finite or negative `retryMs`, `staleAfterMs` and `watchdogMs` and a `maxAttempts` that is not a positive integer.
