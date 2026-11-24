---
'mppx': patch
---

Fixed `Credential.deserialize` to reject credentials whose `payload` is not a JSON object or whose `source` is not a string.
