---
"mppx": minor
---

- Added `title` and `description` options to `Proxy.create` config, used to populate the `llms.txt` heading and description.
- Added `title`, `description`, and `docsLlmsUrl` properties to `Service` type and `Service.from` config.
- `docsLlmsUrl` accepted a string (static root URL) or a function `(endpoint?) => string | undefined` for per-endpoint documentation URLs.
- `Service.serialize()` now included `title`, `description`, `docsLlmsUrl` (root), and per-route `docsLlmsUrl` in the JSON output.
- `Service.toLlmsTxt()` rendered structured route metadata with `Type`, `Price`, `Currency`, and `Docs` sub-bullets.
- `openai`, `anthropic`, and `stripe` services now included hardcoded `title`, `description`, and per-endpoint Context7 documentation URLs.
