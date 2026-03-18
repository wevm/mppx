---
"mppx": patch
---

Fixed cooperative close to sign the server-reported spent amount instead of the high-water mark (`cumulativeAmount`), preventing overcharging when actual usage was below the pre-authorized voucher amount.
