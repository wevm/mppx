---
'mppx': minor
---

Fixed payment enforcement, stream handling, and excessive callback overhead in Express, and hardened subscription signing and CLI retries against chain mismatches and cleartext payment requests. Proxy replay now requires a stable, explicitly configured `replay.authority`, shared only by replicas with identical payment policies and upstream permissions.
