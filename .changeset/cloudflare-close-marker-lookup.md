---
'mppx': patch
---

Fixed `mppx/cloudflare` settlement and channel lookup: a payer close request stamped at or before the server's own cooperative-close marker is now sent to the settlement queue once that marker can no longer land, with an alarm at the marker's end; and a lookup add skips a channel that no longer resumes, while a full lookup entry drops closed channels before an open one.
