---
'mppx': minor
---

Add OpenAPI-first discovery tooling via `mppx/discovery`, framework `discovery()` helpers, and `mppx discover validate`.

This also changes `mppx/proxy` discovery routes:

- `GET /openapi.json` is now the canonical machine-readable discovery document.
- `GET /llms.txt` remains available as the text-friendly discovery view.
- Legacy `/discover*` routes now return `410 Gone`.
