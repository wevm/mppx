---
'mppx': patch
---

Declared `@stripe/stripe-js` as a dependency so the shipped sources type-check for consumers resolving the `src` export condition. The import is type-only, so no runtime code is added.
