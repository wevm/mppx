---
'mppx': patch
---

Fixed payment-aware fetch to return a post-payment `402` response with no actionable challenge instead of throwing `No method found for challenges`.
