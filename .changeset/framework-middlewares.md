---
"mpay": minor
---

Added framework middleware adapters for Hono, Express, Next.js, and Elysia.

```ts
import { Mpay, tempo } from 'mpay/hono'

const mpay = Mpay.create({ methods: [tempo.charge()] })

app.get('/premium', mpay.charge({ amount: '1' }), (c) =>
  c.json({ data: 'paid content' }),
)
```
