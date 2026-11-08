---
'mppx': patch
---

Fixed `mppx stripe address --env` to recognize multiline dotenv values whose key starts with a digit, so a line inside one is no longer taken for the deposit address.
