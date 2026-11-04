---
'mppx': patch
---

Bound automatic session signatures and stored channel reuse to the authorized HTTP origin. Applied `trustedTempoProofRealms` to session challenges and forwarded manager pins. Added `session({ origin })` for direct credentials that will be reused over HTTP; originless stored channels must be explicitly migrated or closed rather than silently rebound.

Preserved request swap policies for automatic session top-ups and payment suppression through identity wrappers. Kept MCP adapter approval and payer selection authoritative when global payment fetch is installed. Limited proxy request bodies, including free routes, to 10 MiB by default with a configurable `maxRequestBodySize`.
