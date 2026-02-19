---
"mppx": patch
---

- Added `title` and `description` options to `Proxy.create` config, used to populate the `llms.txt` heading and description.

```ts
const proxy = Proxy.create({
  title: 'My AI Gateway',
  description: 'A paid proxy for LLM and AI services.',
  services: [...]
})
```

- Added `title`, `description`, and `docsLlmsUrl` properties to `Service` type and `Service.from` config.
- `docsLlmsUrl` accepted a string (static root URL) or a function `(endpoint?) => string | undefined` for per-endpoint documentation URLs.

```ts
Service.from('my-api', {
  baseUrl: 'https://api.example.com',
  title: 'My API',
  description: 'A custom API service.',
  docsLlmsUrl: 'https://context7.com/my-org/my-api/llms.txt',
  routes: { ... },
})

// or with per-endpoint docs
Service.from('my-api', {
  baseUrl: 'https://api.example.com',
  docsLlmsUrl: (endpoint) =>
    endpoint
      ? `https://context7.com/my-org/my-api/llms.txt?topic=${encodeURIComponent(endpoint)}`
      : undefined,
  routes: { ... },
})
```

- `Service.serialize()` now included `title`, `description`, `docsLlmsUrl` (root), and per-route `docsLlmsUrl` in the JSON output.
- `Service.toLlmsTxt()` rendered structured route metadata with `Type`, `Price`, `Currency`, and `Docs` sub-bullets.
- `openai`, `anthropic`, and `stripe` services now included hardcoded `title`, `description`, and per-endpoint Context7 documentation URLs.
