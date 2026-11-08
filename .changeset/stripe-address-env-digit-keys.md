---
'mppx': patch
---

Fixed `mppx stripe address --env` to recognize multiline dotenv values under any key Node accepts, such as one starting with a digit or holding a space, so a line inside one is no longer taken for the deposit address.
