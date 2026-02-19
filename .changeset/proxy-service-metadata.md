---
"mppx": minor
---

### Proxy

- Added `title` and `description` options to `Proxy.create` config, used to populate the `llms.txt` heading and description.

### Service

- Added `title`, `description`, and `docsLlmsUrl` properties to `Service` type and `Service.from` config.
- `docsLlmsUrl` accepts a string (static root URL) or a function `(endpoint?) => string | undefined` for per-endpoint documentation URLs.
- `Service.serialize()` now includes `title`, `description`, `docsLlmsUrl` (root), and per-route `docsLlmsUrl` in the JSON output.
- `Service.toLlmsTxt()` renders structured route metadata with `Type`, `Price`, `Currency`, and `Docs` sub-bullets.

### Built-in Services

- `openai`, `anthropic`, and `stripe` services now include hardcoded `title`, `description`, and per-endpoint Context7 documentation URLs.
