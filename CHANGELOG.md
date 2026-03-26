# mppx

## 0.4.10

### Patch Changes

- b4e1a3d: Add OpenAPI-first discovery tooling via `mppx/discovery`, framework `discovery()` helpers, and `mppx discover validate`.

  This also changes `mppx/proxy` discovery routes:

  - `GET /openapi.json` is now the canonical machine-readable discovery document.
  - `GET /llms.txt` remains available as the text-friendly discovery view.
  - Legacy `/discover*` routes now return `410 Gone`.

- 70f6595: Fix two production session/SSE robustness issues.

  1. Accept exact voucher replays (`cumulativeAmount == highestVoucherAmount`) as idempotent success after signature verification, while still rejecting lower cumulative amounts and preserving monotonic state advancement rules.
  2. Prevent invalid null-body response wrapping in SSE receipt transport by returning `101/204/205/304` responses directly instead of stream-wrapping them.

- 3c713c9: `tempo.session()` now throws immediately at initialization if no viem `Account` is provided, instead of failing later with an opaque error during channel close. The error message includes an example fix.

## 0.4.9

### Patch Changes

- d9b651d: Added `Store.redis()` adapter for standard Redis clients (ioredis, node-redis, Valkey) with BigInt-safe serialization.
- b69bbee: Fixed Express middleware hanging by constructing a Fetch `Request` directly from Express's `req` API.
- 7da6cfd: Fixed SSE header normalization.
- a2c6cc9: Skipped route amount/currency/recipient validation for topUp and voucher credentials. These `POST`s carry no application body so the route's request hook may produce a different amount than the challenge echoed from the original request. The on-chain voucher signature is the real validation.

## 0.4.8

### Patch Changes

- 99920d0: Updated validation.

## 0.4.7

### Patch Changes

- 2a0b88e: Fixed cooperative close to sign the server-reported spent amount instead of the high-water mark (`cumulativeAmount`), preventing overcharging when actual usage was below the pre-authorized voucher amount.

## 0.4.6

### Patch Changes

- 281005c: Added support for `feePayer` as a URL string on `tempo` method.

## 0.4.5

### Patch Changes

- bbd4b3f: Updated Moderato (testnet) escrow contract address to `0xe1c4d3dce17bc111181ddf716f75bae49e61a336`.

## 0.4.4

### Patch Changes

- b09a35a: fix: update getChannel ABI field order to match new escrow contract
- c520705: Fixed `Client.getResolver` to inject Tempo serializers onto clients missing them, preventing the default serializer from rejecting Tempo-specific transaction fields.
- b09a35a: chore: update mainnet escrow contract address

## 0.4.3

### Patch Changes

- 7f8d103: chore: update mainnet escrow contract address

## 0.4.2

### Patch Changes

- c089da5: Added CLI config via `mppx.config.(js|mjs|ts)`. Allows for extending `mppx` CLI to support non-built-in methods.

## 0.4.1

### Patch Changes

- f2bc051: Support keychain V2 (`0x04`) signatures via ox 0.14 upgrade

## 0.4.0

### Minor Changes

- 143ebc9: Support handler function refs in `compose()`.
  - **`[mppx.tempo.charge, { amount: '1' }]` syntax** — `compose()` now accepts handler function references (e.g. `mppx.tempo.charge`) as the first element of entry tuples, in addition to `Method.AnyServer` objects and `"name/intent"` string keys.
  - **`_method` metadata on nested handlers** — nested handler functions are tagged with their source `Method.AnyServer`, enabling `compose()` to resolve the correct handler.

### Patch Changes

- db2033c: Set `feeToken` during server co-sign and simulation for fee-payer transactions.

  When the client sends a fee-payer (0x78) envelope, `feeToken` is intentionally omitted. The server must set it at co-sign time, but previously never did — causing "Fee token spending limit exceeded" errors. Now resolves `feeToken` from the deserialized transaction or falls back to the chain's default currency.

## 0.3.16

### Patch Changes

- 79bbfc6: Added multi-challenge `mppx.challenge()` combinator for presenting multiple payment methods in a single 402 response, nested accessors (`mppx.tempo.charge(...)`), `Mppx.challenge()` static, `Challenge.fromResponseList()`, and automatic client preference-based challenge selection.
- b4f3c92: Migrated to use `call` instead of manual `eth_estimateGas`.

## 0.3.15

### Patch Changes

- cd42c28: Added `rawFetch` property to the client `Mppx` instance, exposing the original unwrapped fetch function for requests that should bypass 402 payment interception.
- 230ef16: Moved CLI payment logs (Payment Required, Payment Receipt, channel open/close) behind `-v` flag. Added `-vv` for full HTTP headers.

## 0.3.14

### Patch Changes

- 345425f: Removed `expires` from charge request schemas (tempo, stripe). Expiry is now conveyed exclusively via the `expires` auth-param on the Challenge, not duplicated in the request body. Server handlers default to `Expires.minutes(5)` when `expires` is not explicitly provided.
- eb19f32: Added `mode` parameter to `tempo.charge()` client — `'push'` (client broadcasts tx, sends hash) and `'pull'` (client signs tx, server broadcasts). Defaults to `'push'` for JSON-RPC accounts, `'pull'` otherwise.

## 0.3.13

### Patch Changes

- 82206f5: Made `constantTimeEqual` isomorphic by replacing `node:crypto` with `ox` sha256 and a custom constant-time comparison.

## 0.3.12

### Patch Changes

- c28944e: Added `autoSwap` flag to `tempo` method. When enabled, the client automatically swaps from supported currencies via the DEX if the payer lacks the target token.
- 9c23cb7: Fixed fetch polyfill to pass `init` through unmodified for non-402 responses. Previously, every request eagerly destructured `init` to strip the `context` property, creating a new object that could break libraries relying on object identity (e.g. WebSocket upgrade handshakes).

## 0.3.11

### Patch Changes

- fd466c3: Added `waitForConfirmation` option to `session()` and `charge()` payment methods. When `false`, transactions are simulated via `eth_estimateGas` and broadcast without waiting for on-chain confirmation, reducing latency.
- ddb7057: Fixed `Handlers` type to omit shorthand intent keys when multiple methods share the same intent, matching runtime behavior and preventing `TypeError` on collision.

## 0.3.10

### Patch Changes

- 558279e: Added `closeRequestedAt` check in session voucher handler with configurable `channelStateTtl` (default: 60s). Prevented payers from using a channel after initiating a forced close.
- 558279e: Added expiration check on credentials in the core handler. Expired credentials are now rejected with `PaymentExpiredError` instead of being processed.
- 558279e: Added token address validation in `broadcastTopUpTransaction` fee-payer logic. Prevented approve calls to arbitrary contracts in fee-sponsored topUp transactions.
- 558279e: Bound credential verification to the route's configured request. Prevented cross-route scope confusion where a credential issued for one route could be presented at another.
- 558279e: Removed insecure hardcoded `'tmp'` fallback for `secretKey`. `Mppx.create()` now throws a clear error if neither `MPP_SECRET_KEY` env var nor explicit `secretKey` is provided.
- 5d4bb93: Removed `realm` from `PaymentRequiredError` detail message to avoid leaking deployment URLs and hostnames in error responses.

## 0.3.9

### Patch Changes

- a016e1f: Added fee payer support to `settleOnChain` and `closeOnChain` for server-originated transactions on chains where the server EOA has no native tokens. Transactions are built using `prepareTransactionRequest` → dual-sign → `sendRawTransactionSync` with an explicitly resolved fee token.

## 0.3.8

### Patch Changes

- 7cb0d5f: Fixed CLI failing with "No account found" when `MPPX_PRIVATE_KEY` is set to an empty string.

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
