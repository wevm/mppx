---
'mppx': patch
---

Fixed Cloudflare settlement scheduling dropping unpaid spend when an opening voucher exceeded usage. Queue recovery now closes such channels with capture bounded by recorded spend, the accepted voucher, and the deposit.
