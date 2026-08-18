---
'mppx': patch
---

Added a `--protocol` flag to the CLI for choosing between MPP and x402 payment challenges. The CLI now reads `PAYMENT-REQUIRED` challenges and answers them in `PAYMENT-SIGNATURE`, so an x402 server can be paid without dropping to the client library.
