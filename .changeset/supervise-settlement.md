---
'mppx': patch
---

`superviseCloses` accepts a `settlementSchedule`, in raw token units, and settles open channels whose spend crossed it, within spend, reporting them `settled`. Servers that charge with `charge()` rather than through the session handler, whose schedule runs only on its own charges, now collect spend without waiting for a close. `resolveSettlementSchedule` and `ResolvedSettlementSchedule` are exported.
