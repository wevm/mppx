---
'mppx': patch
---

Credited prepaid SSE items that failed before delivery when their spend remained unsettled. Added an idempotent merchant reconciliation hook for declined or uncertain credits, preserving settled funds and delivered-item charges.

Automatic prepaid credits are opt-in with `sse: { autoCreditPrepaid: true, onRefundRequired }`; existing merchant refund handlers remain unchanged. Delivery obligations persist in channel state before a managed stream starts, with bounded records and idempotent credit retries. Refund jobs distinguish uncertain writes from definite failures and expose only finalized captured funds as externally refundable. HTTP close receipts accept spend reduced by credits while retaining authorization and scope validation.
