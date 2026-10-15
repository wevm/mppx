---
'mppx': patch
---

Checked on-chain escrow during managed SSE and WebSocket streams and stopped delivery when escrow closed or checks failed.

Deferred managed SSE charges and settlement until delivery, including the initial tick. Explicitly priced streams no longer included an extra prepaid request tick.
