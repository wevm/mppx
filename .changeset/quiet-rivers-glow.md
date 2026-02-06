---
"mpay": major
---

**Breaking:** Removed `method` option from `Challenge.from()`, `Challenge.deserialize()`, `Challenge.fromHeaders()`, and `Challenge.fromResponse()`.

```diff
- const challenge = Challenge.fromResponse(response, { method })
+ const challenge = Challenge.fromResponse(response)

- const challenge = Challenge.deserialize(value, { method })
+ const challenge = Challenge.deserialize(value)
```
