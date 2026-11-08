---
'mppx': patch
---

Added `mppx stripe address`, which creates a Stripe crypto deposit address for machine payments and prints it, or writes it to an env file with `--env`. The Stripe key comes from `--secret-key`, `STRIPE_SECRET_KEY` or the Stripe CLI's login.
