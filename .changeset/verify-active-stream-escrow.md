---
'mppx': patch
---

Checked on-chain escrow during managed SSE and WebSocket streams and stopped delivery when escrow closed or checks failed.

Reserved the initial request tick before application work and committed it on delivery, releasing it when stream verification failed. Preserved existing explicit-charge pricing.
