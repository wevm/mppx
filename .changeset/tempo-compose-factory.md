---
"mpay": minor
---

Added composed `tempo()` client factory that returns both `charge` and `stream` method intents.

```ts
import { Mpay, tempo } from 'mpay/client'

const mpay = Mpay.create({
  methods: [tempo({ account, deposit: 10_000_000n })],
})
```

`tempo.charge()` and `tempo.stream()` continue to work for individual use. `Mpay.create` now accepts nested tuples in `methods` and flattens them automatically.
