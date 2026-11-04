---
'mppx': patch
---

Removed `@stripe/stripe-js` from `dependencies`. The Stripe HTML payment page bundles Stripe.js at build time, and the Stripe Elements option types in `stripe.charge`'s `html.elements` are now inlined, so the published types no longer import `@stripe/stripe-js`.
