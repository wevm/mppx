---
'mppx': patch
---

Fixed host confusion in the Node adapter (`Request.fromNodeListener`/`toNodeListener`). Protocol-relative (`//evil.com/x`), triple-slash (`///evil.com/x`), backslash (`/\evil.com/x`), and embedded-authority (`//a//evil.com/x`) request targets could previously override the request host derived from the `Host` header, which in turn poisoned the auto-detected challenge `realm`. The adapter now copies only the parsed path and query onto a trusted origin, so the request target's authority can never influence the resulting URL host.
