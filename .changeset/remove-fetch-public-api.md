---
"mpay": minor
---

**Breaking:** Removed `Fetch` from the public API of `mpay/client`. `Mpay.create()` now returns a `fetch` function and polyfills `globalThis.fetch` by default.

```diff
- import { Fetch, tempo } from 'mpay/client'
+ import { Mpay, tempo } from 'mpay/client'

- Fetch.polyfill({
+ Mpay.create({
    methods: [tempo.charge({ account })],
  })

  // globalThis.fetch now handles 402 automatically
  const res = await fetch('/resource')

- Fetch.restore()
+ Mpay.restore()
```

To opt out of polyfilling, set `polyfill: false` and use the returned `fetch`:

```ts
const mpay = Mpay.create({
  polyfill: false,
  methods: [tempo.charge({ account })],
})

const res = await mpay.fetch('/resource')
```
