---
'mppx': patch
---

Fixed Zone payments so that a retry under a new Challenge no longer starts a second withdrawal: `tempo.charge` resumes the outstanding withdrawal for the same terms while it can still pay, and the fetch and MCP clients retry the original Challenge while it settles. Added the `zoneCredentialGraceMs` server option, which accepts a `zone` Credential for up to 5 minutes after its Challenge expires when its withdrawal settled before the expiry.
