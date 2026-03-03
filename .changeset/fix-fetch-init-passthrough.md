---
"mppx": patch
---

Fixed fetch polyfill to pass `init` through unmodified for non-402 responses. Previously, every request eagerly destructured `init` to strip the `context` property, creating a new object that could break libraries relying on object identity (e.g. WebSocket upgrade handshakes).
