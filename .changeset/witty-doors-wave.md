---
"mppx": patch
---

Escape characters above Latin-1 in challenge auth-params so serialized challenges are always valid HTTP header values. Previously a charge `description` containing an em dash, smart quote, or emoji made `Response` construction throw (`Cannot convert argument to a ByteString`) in fetch-compliant runtimes when the challenge was written to the `WWW-Authenticate` header.
