---
"mpay": minor
---

**Breaking:** Changed `getClient` interface to accept an object parameter.

```diff
- getClient: (chainId: number) => Client
+ getClient: ({ chainId }: { chainId?: number | undefined }) => Client
```
