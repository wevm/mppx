---
'mppx': patch
---

Added TIP-1166 configurable account voucher signers to `tempo/session`. Servers accept configurable account (`0x05`) vouchers and close authorizations when `configurableVouchers` is set (default `false`), advertise it in the challenge, and check each voucher against the signer config commitment recorded at open (`OpeningCommitmentRecorded`). Configurable account clients open channels with their config commitment as the salt, sign vouchers with configurable account signatures, refuse to open against servers that do not advertise `configurableVouchers` (`ConfigurableVouchersUnsupportedError`), and surface top-ups that revert because the signer config changed as `SignerConfigChangedError`. `Voucher.verifyVoucher` and `Voucher.verifyCloseAuthorization` take optional `{ configurable, openingCommitment }` options; without them they accept only primitive signatures, as before.
