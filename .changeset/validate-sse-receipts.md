---
'mppx': patch
---

Fixed `mppx validate` failing Tempo session responses that stream over SSE: when the receipt arrives in the event stream instead of the `Payment-Receipt` header, validation checks the `payment-receipt` event in the stream instead of requiring the header, and fails when the stream has none.
