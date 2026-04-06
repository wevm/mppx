---
'mppx': patch
---

Hardened challenge-credential binding semantics. The scope verification that prevents cross-route credential replay now compares the full canonical `request` and `opaque` fields between the echoed credential challenge and the route's expected challenge, instead of only checking a subset of request binding fields (`amount`, `currency`, `recipient`, `chainId`, `memo`, `splits`). This closes a gap where credentials differing only in non-binding request fields or `opaque` could pass the scope check.
