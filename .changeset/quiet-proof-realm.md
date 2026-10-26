---
'mppx': patch
---

Refused to sign a zero-amount Tempo proof when the Challenge realm differs from the hostname of the server that sent it, so another origin can't relay a Challenge and replay the proof at its realm. To allow a server whose realm isn't its hostname, pin the realm to its origin with `trustedTempoProofRealms` on `Mppx.create` and `Fetch.from`, such as `{ 'https://api.example.com': 'MPP Payment' }`. Without an origin (`McpClient.wrap`, or `Mppx.create` with `Transport.mcp()` or a response without a URL), these proofs are refused unless `trustedTempoProofRealms` lists the realm. This matches mpp-rs, mpp-go and pympp.
