---
'mppx': patch
---

Fixed payment retries losing Request-carried HTTP methods and bodies, including valid body overrides. Rejected automatic payment after redirects with ambiguous method rewriting before creating credentials.
