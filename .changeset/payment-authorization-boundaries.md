---
'mppx': minor
---

Fixed implicit TLS bypass for local hostnames, discarded Express payment responses, expiry-crossing replay claims, standalone realm validation, and WebSocket metering from stale challenge prices. Bounded anonymous subscription challenge keys and retained billing keys only after successful payment submission.

Standalone credential APIs now require a configured matching realm or trusted route context. Custom WebSocket routes must return the canonical challenge or set an explicit `amount`. The CLI no longer pays when `--insecure` is enabled. Anonymous subscription setup carries an authenticated encrypted key token in the challenge, using one persistent sealing key instead of per-request pending state. Challenge expiry remains enforced before activation. Previously persisted abandoned keys are not automatically removed.

Preserved successful charge receipts when a challenge expired during settlement, preventing a fresh payment challenge after funds moved.

Preserved Express JSON replacers, spacing, and escaping before payment response wrapping. Preserved HTTPS hostnames for certificate validation; local HTTPS names use the system resolver, while plain HTTP localhost subdomains retain the loopback shortcut.

Selected the key bound to a new subscription challenge before a previously retained billing key, allowing an expired subscription to be activated again for the same payer.
