# mppx

## 0.6.18

### Patch Changes

- d365b41: Added Tempo CLI auto-swap and payment source token options.
- 9f660c2: Added Tempo CLI network shortcuts and challenge chain mismatch checks.
- 538c7fb: Added CLI commands for browsing the MPP services registry.

## 0.6.17

### Patch Changes

- 33df58b: Fixed Tempo session close and settle transactions to resolve funded Tempo fee tokens before signing.

## 0.6.16

### Patch Changes

- b711dc5: Preserved raw challenge opaque values when parsing and echoing credentials.
- 5059bfa: Fixed Tempo charge push verification for smart-account transaction hashes.

## 0.6.15

### Patch Changes

- 2b1cf51: Rejected expired challenges before client-side credential creation.

## 0.6.14

### Patch Changes

- ddf590e: Hardened Tempo session billing against concurrent replay, bodyless POST bypasses, inflated receipts, and close races.
- e53d3cd: Fixed Express middleware to short-circuit Tempo session management responses before route handlers run.
- 02663ab: Hardened fee-payer gas sponsorship validation.

## 0.6.13

### Patch Changes

- Blocked Tempo session charges after a channel force-close was requested and rejected reserved SSE charges during pending close.

## 0.6.12

### Patch Changes

- Fixed missing challenge-bound memo validation for Tempo pull transactions.

## 0.6.11

### Patch Changes

- Fixed Tempo clients and the CLI to prioritize local escrow and deposit configuration over server-provided session challenge overrides.

## 0.6.10

### Patch Changes

- Fixed SSE message encoding so multiline payloads could not forge downstream payment control events.

## 0.6.9

### Patch Changes

- Fixed Stripe proxy to strip caller-supplied `Stripe-Account` headers before forwarding requests upstream.

## 0.6.8

### Patch Changes

- b5561f5: Added an actionable error when Linux account storage cannot find secret-tool.

## 0.6.7

### Patch Changes

- Fixed zero-amount Tempo proof verification to validate non-keychain signature envelopes before trusting their signer address.

## 0.6.6

### Patch Changes

- 78bb8c8: Bumped `ox` to `0.14.18` so the bundled Tempo payment UI preserves `limits[].period` in the on-chain `KeyAuthorization`. Without this, per-period access keys failed signer recovery and silent signing fell back to the wallet approval dialog.

## 0.6.5

### Patch Changes

- 3c5cd4b: Fixed zero-amount Tempo proof credentials to bind signatures to the challenge realm.
- 24604ff: Fixed MCP stdio startup and returned structured CLI command results without writing raw tool output to stdout.

## 0.6.4

### Patch Changes

- 0d1e548: Fixed credential `opaque` serialization to use the spec-compliant base64url string shape, while keeping deserialization backward-compatible with legacy object-shaped credentials.
- 9536014: Added canonical discovery output using `x-payment-info.offers[]` while continuing to accept the legacy flat shorthand during validation and parsing.

## 0.6.3

### Patch Changes

- 530a6ff: Validate session settle/close senders against the channel payee so raw delegated access-key accounts fail fast with a clear error, and use the raw Tempo transaction path for access-key-compatible settlement and close flows.

## 0.6.2

### Patch Changes

- 57354de: Added scope-bound challenge metadata for route replay protection, scope-aware `verifyCredential()` checks, and adapter auto-scoping for Hono and proxy routes.

## 0.6.1

### Patch Changes

- Fixed cross-route credential replay checks by binding `unitType` and allowing `verifyCredential()` to validate credentials against expected route context.

## 0.6.0

### Minor Changes

- e606fa9: **Breaking:** Removed default `Accept-Payment` headers on every outgoing request for polyfilled fetch in browsers. Now defaults to same-origin requests in browser environments. Non-browser environments are unaffected. Use `acceptPaymentPolicy` to control supported payment origins.

### Patch Changes

- e606fa9: Added `acceptPaymentPolicy` option to control when the `Accept-Payment` header is injected on outgoing requests, mitigating CORS preflight failures on non-payment-aware servers.
  - In browsers, `Fetch.polyfill` and `Mppx.create` (with `polyfill: true`) default to `'same-origin'`, preventing cross-origin CORS issues.
  - Non-browser environments and `Mppx.create` with `polyfill: false` default to `'always'`.
  - Supported values: `'always'`, `'same-origin'`, `'never'`, `{ origins: string[] }` (with `*.` wildcard support).
  - Exported `Fetch` namespace from `mppx/client`.

- 1a831eb: Fixed Tempo session content gating and SSE plain-response billing to share request-body detection so HTTP/2 POST requests without Content-Length were classified consistently.

## 0.5.17

### Patch Changes

- 3259157: Added `mppx account export` command for exporting the private key of local keychain-backed accounts.

## 0.5.16

### Patch Changes

- 5b6a938: Thread context through pinned requests so MCP tool calls and HEAD requests cannot bypass the shared management-vs-content gate.
- 22be301: Preserve `keyAuthorization` in fee-sponsored Tempo charge transactions and reject unsupported transaction fields instead of silently dropping them.
- 3e7320d: Charge `tempo/session` SSE streams with `unitType: "request"` once per streamed response instead of once per emitted SSE data event.

## 0.5.15

### Patch Changes

- 7aff8ab: Prevented default HTTP `tempo.session()` content requests from replaying the same accepted voucher without advancing request/response accounting.
- 7aff8ab: Pinned credential verification and compose dispatch to challenge `opaque` metadata so same-economics sibling routes could not replay each other's credentials.

## 0.5.14

### Patch Changes

- 1ba7af2: Hardened sponsored Tempo session `open` and `topUp` flows by enforcing fee-payer policy limits, blocking call smuggling, and adding `feePayerPolicy` support.
- 1ba7af2: Fixed fee-sponsored Tempo charge flows by simulating sponsored transactions before broadcast and binding swap approvals to the DEX input token.
- 1ba7af2: Normalized Tempo session channel IDs across storage and verification paths, preventing case-variant aliases from creating duplicate channel state.

## 0.5.13

### Patch Changes

- 7e16df7: Make Tempo charge fee-sponsorship policy resolve per chain and allow overriding it with `feePayerPolicy`.
- 13d2851: Fixed Tempo HTML pay button text overrides and make the HTML page title follow a custom `paymentRequired` label when `title` is omitted.
- e81f45c: Add Tempo charge `supportedModes` request support so clients and servers can explicitly negotiate `push` vs `pull` settlement.

## 0.5.12

### Patch Changes

- f6ce313: Add typed `paymentPreferences` support that emits `Accept-Payment` on client requests and filters composed server challenges accordingly.
- 7059598: Accept zero-dollar proof credentials signed by authorized Tempo access keys and export Tempo proof DID helpers from `mppx/tempo`.
- b6a18c4: Raised too low fee-payer `maxTotalFee` policy

## 0.5.11

### Patch Changes

- 2aff2c0: Handled malformed Host headers in the Node request listener instead of letting them crash the process.

## 0.5.10

### Patch Changes

- d95c01c: Pruned internal dependencies.

## 0.5.9

### Patch Changes

- 4d7fe94: Bumped internal deps

## 0.5.8

### Patch Changes

- 00572a0: Normalized Tempo fee-payer co-signing for charge flows so the final sponsored transaction is rebuilt from validated fields with centralized fee-payer policy checks.
- 7d4fdab: Centralize the authoritative challenge verification inputs by adding captured-request and verified-envelope context plumbing, shared canonical HMAC input generation, and a single pinned-request comparison path without changing the existing server hook model.
- b087c21: Add an optional atomic `Store.update()` primitive for custom store backends and use it to make Tempo replay protection and channel state updates safe across distributed deployments.

## 0.5.7

### Patch Changes

- 9cffd24: Added `Config`, `Text`, and `Theme` type exports to `mppx/html` entrypoint.

## 0.5.6

### Patch Changes

- 0c4ce6f: Added `.compose` support to HTML payment links.

## 0.5.5

### Patch Changes

- e7147c2: Bind attribution memo nonce to challenge ID. The 7-byte nonce field (bytes 25–31) is now derived from `keccak256(challengeId)[0..6]` instead of random bytes, preventing transaction hash stealing in push mode. `Attribution.encode()` now requires `challengeId`. The server verifies challenge binding and server fingerprint for `hash` (push) credentials. Pull-mode `transaction` credentials are not affected — the server controls broadcast, so there is no hash-stealing risk.

  **Breaking:** `Attribution.encode()` now requires `challengeId` — callers must pass the challenge ID to generate a memo. Old push-mode clients that generate random attribution nonces or plain transfers without memos are rejected by the server. Pull-mode clients are unaffected.

## 0.5.4

### Patch Changes

- c3f522c: Fixed CLI defaulting to testnet when `--rpc-url` is omitted. The CLI now defaults to Tempo mainnet. Also added `resolveRpcUrl` helper so `MPPX_RPC_URL` and `RPC_URL` env vars are respected consistently across all commands.
- f086276: Added theming to automatic HTML payment links.

## 0.5.3

### Patch Changes

- ba0bb60: Override vulnerable `lodash` (`<=4.17.23`) to `>=4.18.0` in pnpm overrides. Fixes code injection via `_.template` ([GHSA-r5fr-rjxr-66jc](https://github.com/advisories/GHSA-r5fr-rjxr-66jc)) and prototype pollution via `_.unset`/`_.omit` ([GHSA-f23m-r3pf-42rh](https://github.com/advisories/GHSA-f23m-r3pf-42rh)).

## 0.5.2

### Patch Changes

- 2a7dbd3: Added experimental support for payment links
- 20f3fe4: Hardened credential verification, transport billing, error responses, and proxy routing. Credential request binding now verifies fields match the actual incoming request. SSE transport derives billing context directly from the verified credential payload. 402 error responses no longer leak internal details. Proxy routing binds management POST fallback to the credential's payment method and intent for correct disambiguation.

## 0.5.1

### Patch Changes

- dd27cb1: Validate the `did:pkh:eip155` source DID on zero-dollar Tempo proof credentials. Servers now reject malformed proof source DIDs and chain ID mismatches between the source DID and the challenge signing domain.

## 0.5.0

### Minor Changes

- 5e7750b: Added a `proof` credential type for zero-amount Tempo charge requests. Clients now sign an EIP-712 proof over the challenge ID instead of creating a broadcastable transaction, and servers verify the proof against the credential source DID before accepting the request. This prevents zero-dollar auth flows from burning gas when the payer would otherwise have been the fee payer.

## 0.4.12

### Patch Changes

- 5684b94: Fixed `settleOnChain` and `closeOnChain` to use the payee account as
  `msg.sender` instead of the fee payer when submitting fee-sponsored
  transactions. Previously, `sendFeePayerTx` used the fee payer as both
  sender and gas sponsor, causing the escrow contract to revert with
  `NotPayee()`. Added `account` option to `tempo.settle()` so callers can
  specify the signing account separately from the fee payer.
- 3bc8657: Added compile-time guard to `tempo.session()` and `tempo.charge()`. Unknown properties (e.g. `stream` instead of `sse`) now cause a type error instead of being silently accepted.
- 0531edd: Added split-payment support to Tempo charge requests, including client transaction construction and stricter server verification for split transfers.
- 6188184: Added `realm` auto-detection from the request `Host` header when not explicitly configured. Resolution order: explicit value → env vars (`MPP_REALM`, `FLY_APP_NAME`, `VERCEL_URL`, etc.) → request URL hostname → `"MPP Payment"` fallback with a one-time warning. Removed the hard-coded `"MPP Payment"` default and deprioritized `HOST`/`HOSTNAME` env vars in favor of platform-specific alternatives.
- ba79504: Return `410 ChannelClosedError` instead of `402 AmountExceedsDepositError` when a channel's on-chain deposit is zero but the channel still exists (payer is non-zero). This handles a race window during settlement where the escrow contract zeros the deposit before setting the finalized flag.

## 0.4.11

### Patch Changes

- Fixed close voucher validation to reject vouchers equal to the on-chain settled amount. ([GHSA-mv9j-8jvg-j8mr](https://github.com/wevm/mppx/security/advisories/GHSA-mv9j-8jvg-j8mr))
- Added Stripe credential replay protection via the `Idempotent-Replayed` header. ([GHSA-8mhj-rffc-rcvw](https://github.com/wevm/mppx/security/advisories/GHSA-8mhj-rffc-rcvw))

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

- 99920d0: Updated validation. ([GHSA-8x4m-qw58-3pcx](https://github.com/wevm/mppx/security/advisories/GHSA-8x4m-qw58-3pcx))

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
