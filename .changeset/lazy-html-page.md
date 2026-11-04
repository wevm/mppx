---
'mppx': patch
---

Fixed Tempo and Stripe server bundles always including their HTML payment page: the page now loads with a dynamic `import()` the first time it is rendered, and `html.content` also accepts an async loader.
