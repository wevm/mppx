---
'mppx': patch
---

Added `machineTokenSessionEnabled` to `tempo()` and `tempo.session()`: it offers MACH as a direct TIP-1034 session currency on Tempo mainnet and Moderato. Sessions in MACH now default their fee token to the chain's default stablecoin, since MACH cannot pay transaction fees.
