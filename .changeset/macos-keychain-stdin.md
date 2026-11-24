---
'mppx': patch
---

Fixed macOS account storage passing the private key in `security` process arguments. The CLI now sends the keychain command on stdin through `security -i`.
