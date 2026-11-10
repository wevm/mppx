---
'mppx': patch
---

Added MACH onramp links to insufficient-balance errors. `Tempo.machineTokenFundingUrl` builds the Tempo Wallet link that buys MACH, and `PaymentError` gained an optional `fundingUrl`, serialized as a Problem Details extension member. On Tempo mainnet, the `tempo.charge` client now throws `InsufficientBalanceError` with the link when a MACH-enabled charge can't be paid from MACH or the charge currency, the session client does the same for a MACH channel deposit, servers link MACH payments rejected for a low MACH balance, and the `mppx` CLI treats a MACH-enabled charge as payable from a MACH balance.
