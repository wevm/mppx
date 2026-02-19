---
"mppx": patch
---

Renamed internal `stream` terminology to `session` to align with the MPP spec. This includes renaming the `src/tempo/stream/` directory to `src/tempo/session/`, updating all problem type URIs from `…/problems/stream/…` to `…/problems/session/…`, and renaming associated types (e.g., `StreamCredentialPayload` → `SessionCredentialPayload`). No public API changes.
