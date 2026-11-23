---
'mppx': patch
---

Required an explicit host allowlist or fixed Node host before accepting signed identity headers in Node and Express adapters. Unconfigured adapters now return 421 for those requests.
