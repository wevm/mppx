---
"mppx": minor
---

Added `asAddress` utility to `mppx/utils` for safely narrowing environment variable strings to `Address`. Validates with `isAddress` and throws a clear error on invalid input, replacing blind `as 0x${string}` casts.
