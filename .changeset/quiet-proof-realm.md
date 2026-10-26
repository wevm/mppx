---
'mppx': patch
---

Refused to sign a zero-amount Tempo proof when the Challenge realm differs from the hostname of the server that sent it, so another origin can't relay a Challenge and replay the proof at its realm. To allow a server whose realm isn't its hostname, pin the realm to its origin with `trustedTempoProofRealms` on `Mppx.create` and `Fetch.from`, such as `{ 'https://api.example.com': 'MPP Payment' }`. Without an origin (`McpClient.wrap`, or `Mppx.create` with `Transport.mcp()`), these proofs are refused unless `trustedTempoProofRealms` lists the realm. The `mppx` CLI and `sessionManager` bootstrap apply the same check, and `sessionManager` takes `trustedTempoProofRealms` too. This matches mpp-rs, mpp-go and pympp.
