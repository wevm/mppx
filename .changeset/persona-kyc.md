---
'mppx': patch
---

Added `mppx/extensions/identity/persona`: `Persona.Server.create` starts Persona inquiries and returns a payment check and a request-stage verifier that require an approved inquiry, with an onboarding link on rejection and an optional approval cache. `Persona.Server.verifyWallet` links a wallet to a person before KYC, and `Persona.did` builds a wallet's reference ID.
