---
'mppx': patch
---

The Tempo fee-payer (sponsor) pre-broadcast simulation now simulates the co-signed transaction the sponsor actually broadcasts — with the concrete fee payer and chosen fee token — instead of the pre-cosign `0x78` envelope, for both local and hosted (`feePayerUrl`) fee payers. This catches reverts in the exact transaction the sponsor pays gas for, and fails closed (no broadcast) when the simulation reverts.
