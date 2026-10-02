---
'mppx': patch
---

Added paired Elysia lifecycle hooks that wrapped actual route responses for streaming metering. Rejected streaming payments registered with only a beforeHandle hook and required Elysia 1.2.0 or newer.
