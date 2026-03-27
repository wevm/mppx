---
'mppx': patch
---

Added `realm` auto-detection from the request `Host` header when not explicitly configured. Resolution order: explicit value → env vars (`MPP_REALM`, `FLY_APP_NAME`, `VERCEL_URL`, etc.) → request URL hostname → `"MPP Payment"` fallback with a one-time warning. Removed the hard-coded `"MPP Payment"` default and deprioritized `HOST`/`HOSTNAME` env vars in favor of platform-specific alternatives.
