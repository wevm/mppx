---
'mppx': patch
---

Added `Store.sql()`, an atomic store on SQL databases (single-statement compare-and-swap, no transactions needed), with `Store.postgres()` for `pg`, Neon, Vercel Postgres, Supabase and PGlite, `Store.sqlite()` for `node:sqlite`, `better-sqlite3` and `bun:sqlite`, and `Store.d1()` for Cloudflare D1.
