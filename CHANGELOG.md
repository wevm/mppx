# mppx

## 0.3.1

### Patch Changes

- e6c9f85: Fixed `/discover.md` route returning 404.

## 0.3.0

### Minor Changes

- d60f623: - **`mpp/proxy` (Breaking):** Renamed `/services*` discovery routes to `/discover*`.
  - `mpp/proxy`: Simplified `llms.txt` to a brief service overview, linking each service to `/discover/<id>`.
  - `mpp/proxy`: Added `/discover` and `/discover/<id>` endpoints with content negotiation (JSON by default, markdown for `Accept: text/markdown`/`text/plain` or bot/CLI user agents).
  - `mpp/proxy`: Added `.md` extension variants (`/discover.md`, `/discover/<id>.md`) for explicit markdown.
  - `mpp/proxy`: Added `/discover/all` for full markdown listing with route details.

## 0.2.6

### Patch Changes

- 83c3bab: - Added `title` and `description` options to `Proxy.create` config, used to populate the `llms.txt` heading and description.

  ```ts
  const proxy = Proxy.create({
    title: 'My AI Gateway',
    description: 'A paid proxy for LLM and AI services.',
    services: [...]
  })
  ```

  - Added `title`, `description`, and `docsLlmsUrl` properties to `Service` type and `Service.from` config.

  ```ts
  Service.from('my-api', {
    baseUrl: 'https://api.example.com',
    title: 'My API',
    description: 'A custom API service.',
    docsLlmsUrl: 'https://example.com/llms.txt',
    routes: { ... },
  })

  // or with per-endpoint docs
  Service.from('my-api', {
    baseUrl: 'https://api.example.com',
    docsLlmsUrl: (endpoint) =>
      endpoint
        ? `https://example.com/api/${encodeURIComponent(endpoint)}.md`
        : 'https://example.com/llms.txt',
    routes: { ... },
  })
  ```

## 0.2.5

### Patch Changes

- 01fa8ba: Added fallback `authorizedSigner` to `account.accessKeyAddress` when not explicitly provided.

## 0.2.4

### Patch Changes

- 83d0175: Bumped `viem` peer dependency to `>=2.46.2`.

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
