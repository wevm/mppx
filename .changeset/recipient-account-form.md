---
"mpay": minor
---

Added support for passing an `Account` as `recipient` to server-side `tempo.charge()` and `tempo.stream()`. When an `Account` is passed, its `address` is used as the payment recipient. Setting `feePayer: true` makes the recipient account also sponsor transaction fees.

```ts
import { Mpay, tempo } from 'mpay/server'

const mpay = Mpay.create({
  methods: [
    tempo.charge({
      recipient: account,
      feePayer: true,
      currency: '0x...',
    }),
  ],
})
```
