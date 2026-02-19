---
"mppx": patch
---

Added Stripe payment method support to the CLI.

```bash
# Set your Stripe test-mode secret key
export MPPX_STRIPE_SECRET_KEY=sk_test_...

# Make a request to a Stripe-enabled endpoint
mppx https://example.com/content
```
