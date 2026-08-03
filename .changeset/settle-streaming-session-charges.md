---
'mppx': patch
---

Added a session-bound WebSocket server helper that reused the configured store and settlement policy, and applied that policy to plain HTTP responses from SSE-enabled methods. Fixed automatic settlement schedules after committed Tempo session SSE and WebSocket charges.
