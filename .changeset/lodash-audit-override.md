---
'mppx': patch
---

Override vulnerable `lodash` (`<=4.17.23`) to `>=4.18.0` in pnpm overrides. Fixes code injection via `_.template` ([GHSA-r5fr-rjxr-66jc](https://github.com/advisories/GHSA-r5fr-rjxr-66jc)) and prototype pollution via `_.unset`/`_.omit` ([GHSA-f23m-r3pf-42rh](https://github.com/advisories/GHSA-f23m-r3pf-42rh)).
