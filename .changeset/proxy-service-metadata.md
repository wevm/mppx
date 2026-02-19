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
```ts
Service.from('my-api', {
  baseUrl: 'https://api.example.com',
  title: 'My API',
  description: 'A custom API service.',
  docsLlmsUrl: 'https://example.com/llms.txt',
  routes: { ... },
})

// or with per-endpoint docs
Service.from('my-api', {
  baseUrl: 'https://api.example.com',
  docsLlmsUrl: (endpoint) =>
    endpoint
      ? `https://example.com/api/${encodeURIComponent(endpoint)}.md`
      : undefined,
  routes: { ... },
})
```
