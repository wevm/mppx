---
'mppx': patch
---

Preserved method-specific extension fields on receipts. `Receipt.from`, `Receipt.deserialize`, and `Receipt.fromResponse` previously stripped fields outside the base set; they now pass unknown fields through, per the core spec's Payment-Receipt provision ("Payment method specifications MAY define additional fields for receipts").
