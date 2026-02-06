---
"mpay": major
---

**Breaking:** Refactored tempo method exports to use `tempo.charge()` namespace.

```diff
import { Mpay, tempo } from 'mpay/server'

const mpay = Mpay.create({
-  methods: [tempo()],
+  methods: [tempo.charge()],
})
```
