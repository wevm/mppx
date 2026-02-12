---
"mpay": patch
---

Added client-side MPP attribution memo generation for on-chain observability. The client now auto-generates a 32-byte attribution memo embedded in TIP-20 `transferWithMemo` calls, making MPP transactions identifiable on-chain. User-provided memos take priority. Pass `clientId` to `tempo.charge()` to include a client fingerprint.
