---
"mppx": minor
---

Support handler function refs in `compose()`.

- **`[mppx.tempo.charge, { amount: '1' }]` syntax** — `compose()` now accepts handler function references (e.g. `mppx.tempo.charge`) as the first element of entry tuples, in addition to `Method.AnyServer` objects and `"name/intent"` string keys.
- **`_method` metadata on nested handlers** — nested handler functions are tagged with their source `Method.AnyServer`, enabling `compose()` to resolve the correct handler.
