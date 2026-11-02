# mppx

The TypeScript SDK for MPP and its reference implementation: client and server abstractions for the full HTTP 402 payment flow, payment methods (Tempo, Stripe, EVM, x402), framework middlewares, MCP transport, a proxy and the `mppx` CLI. Other SDKs match its behavior, names and error types, so changes here propagate to them.

## Commands

```bash
pnpm install                     # Install dependencies
pnpm build                       # Sync version, bundle HTML, build the library (zile) and CLI
pnpm check                       # Lint and format with fixes (vp lint --fix, vp fmt --write)
pnpm check:ci                    # Lint and format check, as CI runs it
pnpm check:types                 # Bundle HTML, then type-check (tsgo -b)
pnpm check:types:html            # Type-check the Tempo and Stripe HTML payment pages
pnpm check:types:examples        # Type-check every package under examples/
pnpm check:package               # Check package contents and size
pnpm audit --ignore-registry-errors  # Audit dependencies
pnpm changeset status --since=HEAD^1 # CI requires a changeset on pull requests
pnpm exec vp test --run --project node     # Unit tests, no localnet
pnpm exec vp test --run --project tempo    # Tests against a Tempo localnet on port 18545
pnpm exec vp test --run --project cli      # CLI tests (need a keyring: libsecret / gnome-keyring)
pnpm exec vp test --run --project browser  # Browser unit tests (Playwright Chromium)
pnpm test:html                   # Playwright tests of the HTML payment pages
```

Run one test file by project and path, for example `pnpm exec vp test --project node src/server/Mppx.test.ts`. A bare `pnpm test <path>` runs the `tempo` project's global setup and fails without a localnet on port 18545. CI starts that localnet with Docker (`ghcr.io/tempoxyz/tempo`, `--dev`, port 18545 mapped to 54515; see `.github/workflows/verify.yml`) and runs node and tempo tests in shards. Files that use the funded Tempo accounts belong to the `tempo` project through `test/runtime/tempo-suites.ts`; add a new such file there by hand. The x402 end-to-end projects (`x402-localnet`, `x402-coinbase-client`) need an Anvil container on port 18546 and Forge fixtures. `pnpm test:html` uses `MPP_SECRET_KEY` and, for Stripe, `VITE_STRIPE_SECRET_KEY` and `VITE_STRIPE_PUBLIC_KEY`. Run `pnpm build` before tests: they load the bundled HTML.

## Layout

- `src/`: the library. Top-level modules are the primitives (`Challenge.ts`, `Credential.ts`, `Receipt.ts`, `Method.ts`, `PaymentRequest.ts`, `Errors.ts`, `Store.ts`, `BodyDigest.ts`, `Expires.ts`).
- `src/client/` and `src/server/`: the client and server `Mppx` handlers (`mppx/client`, `mppx/server`).
- `src/tempo/`, `src/stripe/`, `src/evm/`, `src/x402/`: payment methods and their client and server halves.
- `src/middlewares/`: Hono, Express, Next.js and Elysia integrations.
- `src/mcp/`: MCP client and server transport. `src/discovery/`: OpenAPI discovery. `src/proxy/`: the payment proxy and its services. `src/identity/`, `src/extensions/`: identity extensions.
- `src/cli/`, `src/bin.ts`: the `mppx` CLI.
- `test/`: shared test helpers, setup, HTML Playwright tests (`test/html/`) and shard config (`test/runtime/`).
- `examples/`: runnable example apps, a pnpm workspace each.
- `scripts/`: build, publish and maintenance scripts.
- `vite.config.ts`: test projects and the `mppx/*` import aliases.

## Conventions

- Keep code as simple as possible. Prefer existing patterns and avoid unnecessary abstractions.
- Add JSDoc to exported functions and to any complicated function.
- mppx is pre-v1: always use `patch` bumps, including for new features, additive API surface, refactors and fixes. Use `minor` only for a substantial, unavoidable breaking change that requires consumer migration (removing or renaming a public export, changing a hook signature incompatibly). Never use `major` until v1.
- Never edit `CHANGELOG.md` by hand; `changeset version` generates it. Add a changeset as `.changeset/<name>.md`, written in past tense ("Added support for …", "Fixed parsing of …"):

  ```md
  ---
  'mppx': patch
  ---

  Added support for ….
  ```

- Keep pnpm overrides in `pnpm-workspace.yaml`, not `package.json`; CI fails otherwise.
- Log papercuts and friction (tooling, docs, APIs, tests, conventions) as you hit them with `pnpx frog log`. Run `pnpx frog list` first to see what is already known. Do not add global, system or internal friction.

## Architecture

mppx has two layers: core abstractions that run the HTTP 402 flow, and primitives they compose.

### Core abstractions

1. **`Mppx`**: the top-level payment handler. Groups related `Method`s and handles the 402 flow (Challenge and Credential parsing, header serialization, verification).
2. **`Method`**: a payment method definition, with a `method` (such as `tempo`, `stripe`), a `name` (the intent, such as `charge`, `session`) and schemas for request validation and Credential payloads.

```
┌────────────────────┐       ┌────────────────┐
│       Mppx         │ 1   * │     Method     │
│    (handler)       ├───────┤  (definition)  │
└────────────────────┘ has   └────────────────┘
│ payment            │       │ tempo/charge   │
│                    │       │ tempo/session  │
│                    │       │ stripe/charge  │
└────────────────────┘       └────────────────┘
```

```
Client (Mppx)                                       Server (Mppx)
   │                                                   │
   │  (1) GET /resource                                │
   ├──────────────────────────────────────────────────>│
   │                                                   │
   │             (2) handler.charge(request, { ... })  │
   │                   402 + WWW-Authenticate: Payment │
   │<──────────────────────────────────────────────────┤
   │                                                   │
   │  (3) handler.createCredential(response)           │
   │                                                   │
   │  (4) GET /resource                                │
   │      Authorization: Payment <credential>          │
   ├──────────────────────────────────────────────────>│
   │                                                   │
   │               (5) handler.charge(request)         │
   │                                                   │
   │               (6) 200 OK                          │
   │                   Payment-Receipt: <receipt>      │
   │<──────────────────────────────────────────────────┤
   │                                                   │
```

### Primitives

- **`Challenge`** (`src/Challenge.ts`): the server's payment request. Also computes and verifies the HMAC-bound Challenge `id`.
- **`Credential`** (`src/Credential.ts`): the client's payment proof: the Challenge echo, a method-specific `payload` and an optional `source` (payer identity).
- **`Receipt`** (`src/Receipt.ts`): the server's settlement confirmation.
- **`Request`**: method-specific payment parameters (such as `amount`, `currency`, `recipient`), validated by the method's schema and serialized in the Challenge.
- **`Method`** and **`Mppx`**, as above.

### Method architecture

Methods are flat structural types with `method`, `name` and `schema`:

```ts
const tempoCharge = Method.from({
  method: 'tempo',
  name: 'charge',
  schema: {
    credential: {
      payload: z.object({ signature: z.string(), type: z.literal('transaction') }),
    },
    request: z.pipe(
      z.object({
        amount: z.amount(),
        chainId: z.optional(z.number()),
        currency: z.string(),
        decimals: z.number(),
        recipient: z.optional(z.string()),
        // ...
      }),
      z.transform(({ amount, decimals, chainId, ... }) => ({
        amount: parseUnits(amount, decimals).toString(),
        ...(chainId !== undefined ? { methodDetails: { chainId } } : {}),
      })),
    ),
  },
})
```

`Method.toClient()` and `Method.toServer()` extend a method with client or server logic:

```ts
// Client-side: adds credential creation
const client = Method.toClient(Methods.charge, {
  async createCredential({ challenge }) { ... },
})

// Server-side: adds verification
const server = Method.toServer(Methods.charge, {
  async verify({ credential }) { ... },
})
```

## Skills

Load these skills when they are available:

- `payment-auth-scheme-author`: implementing payment methods, the 402 flow, Tempo or Stripe method schemas, or the IETF Specification.
- `typescript-library-best-practices`: building new modules or structuring exports.
- `typescript-style-guide`: writing or reviewing TypeScript for style.
- `tempo-developer`: Tempo protocol specifics, TIP-20 tokens and Tempo transactions (`0x76`).

<!-- BEGIN MPP SHARED: synced from tempoxyz/mpp-tools agents/shared.md. Edit it there; changes here are overwritten. -->

## MPP

Conventions every MPP repository shares, pulled together from their AGENTS.md files. Synced from [`agents/shared.md`](https://github.com/tempoxyz/mpp-tools/blob/main/agents/shared.md) in tempoxyz/mpp-tools: edit it there. The sections above it are this repository's own and win where they are more specific.

### This file

- Keep it to `# <repository>` and a short paragraph, then `## Commands`, `## Layout`, `## Conventions`, then only the sections this repository needs, then this section.
- Write rules an agent can act on: commands, paths, constraints. Leave out background, history and anything the code, specs or README already say.
- When you learn a convention the hard way, add it to the section it belongs to in the same pull request.

### Code

- Make the smallest change that does the job and follow the surrounding code. Start concrete; extract an abstraction only once several real uses share it.
- Keep the public API narrow. Add rather than remove or rename, and mark what you replace as deprecated before deleting it.
- Document every exported item (JSDoc, rustdoc, docstrings, Go doc comments). Comments say why, not what.
- Match mppx, the reference SDK: its names (Challenge, Credential, Receipt, Method), defaults, errors and behavior, unless the language forces otherwise; say why when it does.
- The IETF drafts in tempoxyz/mpp-specs (paymentauth.org) are the source of truth for the protocol, and mppx settles what they leave open. Link them instead of restating them.
- Add no dependency without a reason the pull request states. Prefer the standard library and what the repository already uses.
- Never log or commit keys, credentials, signatures, authorization headers or raw upstream errors.
- Tempo chain IDs: mainnet `4217`, Moderato testnet `42431`. Never `98865`.

### Tooling

Use each language's standard toolchain, run through the commands in `## Commands`, and keep it clean with warnings as errors:

- TypeScript: pnpm, strict `tsc`, ESM with `.js` relative imports, the repository's configured formatter and linter, Vitest.
- Python: uv, ruff (format and lint), a strict type checker (pyright or ty), pytest or unittest.
- Rust: cargo, `cargo fmt`, `cargo clippy -D warnings`, `cargo test`.
- Go: `gofmt`, `go vet`, golangci-lint, `go test -race`.
- Swift: SwiftPM, `swift test -Xswiftc -warnings-as-errors`.
- Run the checks that cover your change before opening a pull request, and add tests for behavior that matters, next to the existing ones.
- Pin GitHub Actions by full commit SHA. Workflows start with `tempoxyz/gh-actions/actions/secure-runner` and get write tokens from GitHub STS policies in `.github/sts/`, never stored secrets.

### Changes

- Commits and pull request titles use Conventional Commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`, optionally scoped.
- Never edit `CHANGELOG.md` by hand. Record a release note the way `## Conventions` says (changeset, `.changelog/` fragment, or none when a workflow writes it), in the past tense.
- Before 1.0, bump `patch` for everything except a breaking public API change, which is `minor`.
- Don't edit README files unless asked.
- Never force-push.

### Docs and prose

- Active voice, present tense, second person. Sentence-case headings. No filler (just, simply, easily) and no Latin abbreviations.
- Capitalize Challenge, Credential and Receipt as MPP concepts. Say stablecoins, not crypto, and USDC.e for bridged USDC on Tempo. Write `mppx` in lowercase.

<!-- END MPP SHARED -->
