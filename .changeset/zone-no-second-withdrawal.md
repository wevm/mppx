---
'mppx': patch
---

Fixed Zone payments so that a retry under a new Challenge no longer starts a second withdrawal: `tempo.charge` resumes the outstanding withdrawal for the same terms, and the fetch and MCP clients retry the original Challenge while it settles. Servers now accept a `zone` Credential up to 5 minutes after its Challenge expires when its withdrawal settled before the expiry.
