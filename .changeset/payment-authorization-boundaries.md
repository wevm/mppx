---
'mppx': minor
---

Fixed implicit TLS bypass for local hostnames, discarded Express payment responses, expiry-crossing replay claims, standalone realm validation, and WebSocket metering from stale challenge prices. Bounded anonymous subscription challenge keys and retained billing keys only after successful payment submission.

Standalone credential APIs now require a configured matching realm or trusted route context. Custom WebSocket routes must return the canonical challenge or set an explicit `amount`. The CLI no longer pays when `--insecure` is enabled. Anonymous subscription setup retains at most 1,024 pending keys per store for 15 minutes; expired keys are reclaimed on new issuance and callers must retry expired setup challenges. Previously persisted abandoned keys are not automatically removed.
