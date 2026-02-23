# mppx

## 0.3.7

### Patch Changes

- e4f0138: Added `nonceKey: 'expiring'` to tempo charge transactions to avoid nonce collisions on parallel requests.

## 0.3.6

### Patch Changes

- d2fb5e3: Fixed issue where mainnet would not default to USDC unless `testnet: false` was explicitly passed.

## 0.3.5

### Patch Changes

- 6e2be11: Replaced `--channel <id>` and `--deposit <amount>` CLI flags with `-M`/`--method-opt` for passing method-specific options.

  ```diff
  # Before
  - mppx example.com/content --channel 0x123 --deposit 1000000

  # After
  + mppx example.com/content -M channel=0x123 -M deposit=1000000
  ```

- 6e2be11: Added Stripe payment method support to the CLI.

  ```bash
  # Set your Stripe test-mode secret key
  export MPPX_STRIPE_SECRET_KEY=sk_test_...

  # Make a request to a Stripe-enabled endpoint
  mppx https://example.com/content
  ```

- 955deb2: Renamed USDC.e to USDC in account view token list.

## 0.3.4

### Patch Changes

- 9cf4943: Added USDC.e to account view mainnet token list and use `MPPX_RPC_URL` for default mainnet balance fetching.
- 11c0422: Renamed internal `stream` terminology to `session` to align with the MPP spec. This includes renaming the `src/tempo/stream/` directory to `src/tempo/session/`, updating all problem type URIs from `…/problems/stream/…` to `…/problems/session/…`, and renaming associated types (e.g., `StreamCredentialPayload` → `SessionCredentialPayload`). No public API changes.

## 0.3.3

### Patch Changes

- 04b04c9: Added auto-detection of `realm` and `secretKey` from environment variables in `Mppx.create()`.

  - **Realm**: checks `MPP_REALM`, `FLY_APP_NAME`, `HEROKU_APP_NAME`, `HOST`, `HOSTNAME`, `RAILWAY_PUBLIC_DOMAIN`, `RENDER_EXTERNAL_HOSTNAME`, `VERCEL_URL`, `WEBSITE_HOSTNAME`
  - **Secret key**: checks `MPP_SECRET_KEY`

## 0.3.2

### Patch Changes

- b927c06: - `mppx/proxy`: Modified routes to show service in path for completeness (e.g. `POST /openai/v1/chat/completions` instead of `POST /v1/chat/completions`).

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
