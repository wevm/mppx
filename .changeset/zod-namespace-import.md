---
'mppx': patch
---

Fixed esbuild bundles including all of `zod/mini` by importing it as a namespace in `mppx`'s zod helpers, so unused validators tree-shake.
