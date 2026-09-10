---
'mppx': patch
---

Fixed primary recipient allowlist enforcement, session chain pinning, and CLI precedence for configured payment methods so payment limits are preserved.

Preserved configured method selection and Stripe validation, applied recipient allowlists to zero-amount proofs, and kept configured session policies from being replaced by CLI persistence defaults.
