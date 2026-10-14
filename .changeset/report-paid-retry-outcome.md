---
'mppx': patch
---

Added `Errors.PaymentOutcomeUnknownError` and emitted it through `payment.failed` when a paid retry returns a 5xx response, carrying the challenge, credential, and the transaction hash for push and unsponsored Tempo charges. The response is still returned and never retried; when `payment.failed` is observed, its body is first buffered up to 64 KiB within 2 seconds so the connection is released, and a cut-off body is marked with `Mppx-Body-Truncated: true`. A thrown paid retry now passes the same error to `payment.failed` with the original error as `cause`, and the original error is still thrown.
