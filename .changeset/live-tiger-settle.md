---
'mppx': patch
---

Fixed Stripe CLI live-mode Shared Payment Token creation. SPT requests now send the preview `Stripe-Version` header, live-mode requests target the issued-tokens endpoint with `seller_details[network_business_profile]`, and restricted test keys (`rk_test_...`) are recognized as test mode.
