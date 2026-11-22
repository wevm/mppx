---
'mppx': patch
---

Added `mppx/client/core`, `mppx/tempo/client` and `mppx/tempo/server` entrypoints, so apps can load the client primitives or only the Tempo method without the other payment methods. `mppx/client` and `mppx/server` export the same API as before.
