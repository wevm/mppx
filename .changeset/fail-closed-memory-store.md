---
'mppx': patch
---

**Behavior change in production:** Changed `tempo.charge()`, `tempo.session()`, `tempo.subscription()` and `tempo()` to throw at construction when no `store` is passed and `NODE_ENV` is `production`, the server runs on a multi-instance platform (Vercel, AWS Lambda, Netlify, Fly.io, Cloud Run, Render, Railway, Heroku, Deno Deploy) or on Cloudflare Workers, instead of silently keeping replay protection and sponsor budgets in per-instance memory. Pass a shared store, or `store: Store.memory()` to keep instance-local state; local development and tests still fall back to memory with a warning.
