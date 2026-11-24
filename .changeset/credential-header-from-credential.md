---
'mppx': patch
---

Fixed `Transport.http().setCredential` sending a Payment credential in `Authorization` when called without `options.challenge` for a challenge that selects `Payment-Authorization`: it now reads the field from the challenge the credential echoes. It also clears a stale Payment credential from `Payment-Authorization` before attaching a new one.
