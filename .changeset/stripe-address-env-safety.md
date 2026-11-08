---
'mppx': patch
---

Fixed `mppx stripe address` to reject a deposit address that isn't valid for its network (Solana addresses must decode to 32 bytes), refuse env values with line breaks, and leave exactly one assignment of the key when writing with `--env`.
