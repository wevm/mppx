# mppx

## 0.2.3

### Patch Changes

- c0aa6ad: Fixed Stripe `createWithClient` to use `shared_payment_granted_token` instead of `payment_method` when creating a PaymentIntent with an SPT. This aligns the SDK client path with the raw fetch path and fixes 402 errors on credential retry.
- e7f5985: Rejected keychain and non-secp256k1 signatures in `verifyVoucher`.

## 0.2.2

### Patch Changes

- 360fc03: Added `Json.canonicalize` from `ox`

## 0.2.1

### Patch Changes

- eb72c76: **Breaking:**
  - Renamed `Challenge.fromIntent` to `Challenge.fromMethod`.
  - Renamed `PaymentRequest.fromIntent` to `PaymentRequest.fromMethod`.

## 0.2.0

### Minor Changes

- 627f5ec: **Breaking:**

  - Renamed `Intent` and `MethodIntent` modules to `Method`.
  - Removed `Intent` export from `mppx`. Use `Method` instead.
  - Removed `MethodIntent` export from `mppx`. Use `Method` instead.
  - Renamed `MethodIntents` export to `Methods` in `mppx/tempo` and `mppx/stripe`.

## 0.1.1

### Patch Changes

- 910102d: Fixed SSE streaming reliability: pass `signal` through `SessionManager.sse()` so HTTP connections close on abort, snapshot challenge at SSE open time to prevent concurrent requests from corrupting voucher credentials, and forward `request.signal` to `Sse.serve()` so `chargeOrWait` breaks on disconnect.

## 0.1.0

### Minor Changes

- badab1a: Initial release.
