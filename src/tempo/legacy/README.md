# Tempo Legacy Session

This directory contains the legacy smart-contract-backed `tempo/session`
implementation.

The default `tempo.session` implementation is TIP-1034 precompile-backed and
lives under `src/tempo/session/precompile`. Legacy code may import shared transport and
accounting helpers from `src/tempo/session`, but legacy chain, channel, voucher,
client, and server implementations should stay inside this directory.
