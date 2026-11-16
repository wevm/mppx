---
'mppx': patch
---

Added `mppx/extensions/identity/erc8004`: an ERC-8004 agent identity provider. The client prover signs each request with the agent's wallet, and the server's verifier and payment check require that the wallet the Identity Registry names (on Tempo mainnet by default) signed the request or signed the transaction or proof of a `tempo` charge (transaction hashes, sessions, Zones and other methods need the signature). The proxy and cross-origin redirects drop its `Agent-Id` and `Agent-Signature` headers.
