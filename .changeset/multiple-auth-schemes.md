---
"mpay": patch
---

Added support for multiple `Authorization` schemes. `Credential.fromRequest` and the HTTP server transport now correctly extract the `Payment` scheme from headers containing multiple authorization values (e.g., `Bearer` alongside `Payment`).
