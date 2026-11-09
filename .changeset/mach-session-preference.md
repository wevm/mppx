---
'mppx': patch
---

Added MACH session preference to the Tempo session client: when a server offers both a MACH and a stablecoin `tempo/session`, the client opens the MACH session if the wallet (and its access key) can fund the deposit, and falls back to the stablecoin offer otherwise. MACH session open and top-up transactions now pay fees in a separate token: the advertised `feeToken`, else the new `machFeeToken` parameter, else the chain's default stablecoin. MACH is rejected as a fee token.
