---
"mppx": patch
---

Fixed `Handlers` type to omit shorthand intent keys when multiple methods share the same intent, matching runtime behavior and preventing `TypeError` on collision.
