---
'mppx': patch
---

Added client-side Tempo chain pinning. `tempo.charge({ expectedChainId })` rejects charge challenges whose `methodDetails.chainId` conflicts with the configured chain ID, and signs on the pinned chain when the challenge omits it.
