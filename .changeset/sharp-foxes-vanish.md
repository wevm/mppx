---
"mpay": major
---

**Breaking:** Removed `Method` module. Use `MethodIntent` instead.

```diff
- import { Method } from 'mpay'
+ import { MethodIntent } from 'mpay'

- const server = Method.toServer(method, { verify })
+ const server = MethodIntent.toServer(methodIntent, { verify })

- const client = Method.toClient(method, { createCredential })
+ const client = MethodIntent.toClient(methodIntent, { createCredential })
```
