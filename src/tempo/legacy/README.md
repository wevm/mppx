# Tempo Legacy Session

This directory contains compatibility internals for the legacy
smart-contract-backed `tempo/session` implementation. They are not part of the
public package API.

The supported `tempo.session` implementation is TIP-1034 precompile-backed and
lives under `src/tempo/session`. The legacy server implementation and public
client exports have been removed; the remaining source is retained only for
internal compatibility coverage.
