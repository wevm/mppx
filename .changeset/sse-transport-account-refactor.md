---
"mpay": minor
---

**Breaking:** Renamed `recipient` parameter to `account`. The `recipient` parameter now only accepts an `Address` string (in cases where you want a separate recipient address).

```diff
tempo.charge({ 
-  recipient: account,
+  account,
  feePayer: true,
  // or with different recipient address
  recipient: '0x...',
})
```