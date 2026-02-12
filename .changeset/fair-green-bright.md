---
"mpay": patch
---

Added service discovery endpoints to the proxy: `GET /services` (JSON), `GET /services/:id` (JSON), and `GET /llms.txt` (Markdown). Payment metadata (intent, amount, currency, decimals) is automatically extracted from intent handlers.
