# mppx

## 0.1.1

### Patch Changes

- 910102d: Fixed SSE streaming reliability: pass `signal` through `SessionManager.sse()` so HTTP connections close on abort, snapshot challenge at SSE open time to prevent concurrent requests from corrupting voucher credentials, and forward `request.signal` to `Sse.serve()` so `chargeOrWait` breaks on disconnect.

## 0.1.0

### Minor Changes

- badab1a: Initial release.
