# Tempo Legacy Session

This directory contains the retained client for the legacy smart-contract-backed
`tempo/session` implementation.

The default `tempo.session` implementation is TIP-1034 precompile-backed and
lives under `src/tempo/session/precompile`. The legacy server implementation has
been removed, while legacy chain, channel, voucher, and client code remains here
for clients migrating existing sessions.
