---
'mppx': patch
---

Kept the challenge-bound attribution memo required for Tempo push payments (`hash` and Zone credentials); pull (`transaction`) credentials accept a plain transfer, a memo not in attribution format or another realm's attribution memo, and reject this realm's attribution memo for another Challenge. Clients no longer pay again when a credential they attached themselves, or one sent through the MCP client or MCP over HTTP, gets an `invalid-challenge` answer. The HTTP transport no longer counts commas inside another scheme's quoted parameters as extra Payment credentials and checks the 64 KiB limit before parsing, session bootstrap routes answer more than one Payment credential with 400, and EVM charge routes no longer attach an x402 offer to a rejection without a Challenge.
