# mpp-agent: an AI agent whose only integration is a wallet

A small agent harness (under 1,000 lines of TypeScript for the loop, wallet and spending policy) that has **no API keys, no accounts and no tool list**. It gets one primitive, `fetch()` with a stablecoin wallet attached:

- The LLM itself is a paid HTTP endpoint (OpenRouter's MPP proxy).
- Tools are discovered at run time from public MPP directories and paid per call over HTTP 402 ([MPP](https://mpp.dev)).
- Async paid jobs (e.g. video): the agent submits, then `wait_for` polls in code until the job is done, without spending LLM steps; polls are paid and policed like any call.
- A web UI shows every call, its quoted vs charged price, and the on-chain transaction, and can re-verify a run (or the whole wallet) against the chain.

> **Warning:** Each run spends real USDC.e from your Tempo Wallet, up to the limit you approve for this agent. The cap limits the damage, but still run it locally only and don't expose it as a public server: anyone who can reach it can spend that allowance.

## Setup

Takes about 5 minutes. Easiest: paste this into Claude Code and let it walk you through it:

> Set up and run the mpp-agent demo by following SKILL.md in https://github.com/wevm/mppx/tree/main/examples/mpp-agent

Or by hand:

```bash
npx gitpick wevm/mppx/tree/main/examples/mpp-agent && cd mpp-agent
pnpm i
pnpm run setup    # approve this agent in YOUR Tempo Wallet (opens wallet.tempo.xyz)
pnpm dev          # then open http://127.0.0.1:3000
```

Use `pnpm run setup`, not `pnpm setup` (a built-in pnpm command). Inside a full mppx checkout, run `pnpm install && pnpm dev` at the repo root first; the example then uses the local `mppx` source instead of the published package.

### Approve in your Tempo Wallet

`pnpm run setup` asks your [Tempo Wallet](https://wallet.tempo.xyz) to authorize an **access key** for this agent. You approve once with your passkey, using the link and code it prints. The key can spend **up to $5 of USDC.e for 7 days** (change with `pnpm run setup -- --limit=10 --days=30`) and can only make USDC.e transfers. The chain enforces the limit and expiry, and you can revoke the key any time in the wallet app. The key is stored in your macOS keychain, or in `~/.mpp-agent/access-key.json` (mode 600) on Linux, and is never printed.

Setup then **registers the key on chain** with one transaction your wallet pays for (a 0 USDC.e transfer to itself, fee under a cent), because fee-sponsored MPP payments don't accept a key that isn't registered yet. If that's skipped, the first payment does it; `pnpm run setup -- --activate-only` (add `--dry-run` to see the fee) does just this step.

Payments come from your Tempo Wallet, so it needs some USDC.e on Tempo mainnet. No crypto yet? `tempo wallet fund` (Tempo CLI: `curl -fsSL https://tempo.xyz/install | bash`) opens a card / Apple Pay top-up, or use the wallet app. A typical run costs $0.15–0.70. When the allowance runs out or expires, run `pnpm run setup -- --reauthorize`.

### Already have a local demo wallet?

Earlier versions created a separate wallet whose key lived on your machine. That still works: with no access key stored, the agent keeps using it ("legacy mode"), and `pnpm dev` says so. To move to your Tempo Wallet:

1. `pnpm run setup` approves an access key, then offers to move the local wallet's USDC.e to your Tempo Wallet (balance minus the network fee, which Tempo charges in USDC.e). Answer `y`. Or later: `pnpm run migrate` (`--dry-run` to preview, `--yes` to skip the question).
2. Once it's empty, `pnpm run setup -- --forget-local-key` deletes the local key. It refuses while the wallet still holds funds.

### Which wallet pays

`MPP_KEY_SOURCE=auto` (the default) picks a stored Tempo Wallet access key first, then a local demo wallet key, and otherwise tells you to run setup. `pnpm dev` prints which one it's using (addresses only). To force one: `MPP_KEY_SOURCE=tempo-wallet`, or a local key with `keychain`, `file` or `env` (`MPP_PRIVATE_KEY`, used by the testnet e2e). With a local-key mode forced, `pnpm run setup` creates and funds a local demo wallet the old way.

## Safety defaults

- **Budgets per run:** $1.50 total ($0.50 inference, $1.00 tools), and $0.60 max per call, checked against the 402 quote before paying.
- **Wallet allowance:** the access key's limit and expiry cap all runs together. The chain enforces them, and a quote above what's left is refused before paying.
- **Side effects blocked:** email, SMS, phone, mail, purchases, bookings, top-ups and similar are refused before paying.
- **Internal hosts blocked:** localhost, private IP ranges and internal domains (e.g. `.local`, `.consul`) are never requested.
- The model never sees the key. The harness signs payments; prompt injection can at most waste budget, never exceed it.

### Configuration (environment variables, all optional)

| Variable                                                         | Default                          | Meaning                                                                                                                                                                                          |
| ---------------------------------------------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `PORT`                                                           | `3000`                           | Local server port (binds 127.0.0.1)                                                                                                                                                              |
| `MPP_KEY_SOURCE`                                                 | `auto`                           | Which wallet pays: `auto` (access key, else local key), `tempo-wallet`, or a local demo wallet key: `keychain`, `file` (`MPP_KEY_FILE`, default `~/.mpp-agent/key`) or `env` (`MPP_PRIVATE_KEY`) |
| `MPP_ACCESS_KEY_STORE`                                           | `keychain` on macOS, else `file` | Where the Tempo Wallet access key lives (`file`: `MPP_ACCESS_KEY_FILE`, default `~/.mpp-agent/access-key.json`)                                                                                  |
| `MPP_NETWORK`                                                    | `mainnet`                        | `mainnet` = Tempo (USDC.e); `testnet` = Tempo Moderato (pathUSD)                                                                                                                                 |
| `MODEL`                                                          | `anthropic/claude-sonnet-4.5`    | OpenRouter model id                                                                                                                                                                              |
| `BUDGET_TOTAL_USD` / `BUDGET_INFERENCE_USD` / `BUDGET_TOOLS_USD` | `1.50` / `0.50` / `1.00`         | Per-run budgets                                                                                                                                                                                  |
| `MAX_PER_CALL_USD`                                               | `0.60`                           | Largest single payment, checked against the quote                                                                                                                                                |
| `MAX_STEPS`                                                      | `25`                             | Max agent turns per run (sub-agents: up to 12)                                                                                                                                                   |
| `CALL_TIMEOUT_MS`                                                | `300000`                         | Deadline for each HTTP call, including its paid retry (and each `wait_for` poll)                                                                                                                 |
| `MAX_POLLS_PER_RUN`                                              | `150`                            | Most `wait_for` polls per run, sub-agents included (and 60 per wait)                                                                                                                             |
| `ALLOW_SIDE_EFFECT_HOSTS`                                        | (empty)                          | Comma-separated hosts exempt from the side-effect block                                                                                                                                          |
| `HTTPS_PROXY`                                                    | (unset)                          | Route all outbound traffic through a proxy (e.g. an egress proxy)                                                                                                                                |

Example: `BUDGET_TOTAL_USD=0.50 pnpm dev`.

## How it works

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the agent loop.

## What's in here

| Path                                                      | What it is                                                                                                                   |
| --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `src/agent.ts`                                            | The loop: LLM via paid fetch, three tools (`http`, `wait_for`, `done`), plus opt-in `spawn` for sub-agents                   |
| `src/jobs.ts`                                             | `wait_for`: polls an async job in code (through `paidFetch`), and the `http` result nudges that point at it                  |
| `src/paidFetch.ts`                                        | Request → 402 → policy → pay → receipt → on-chain cost                                                                       |
| `src/policy.ts`                                           | Budgets, caps, blocked hosts and side effects                                                                                |
| `src/wallet.ts`, `src/keystore.ts`                        | Which wallet pays (Tempo Wallet access key or local key), the allowance, and the mppx client                                 |
| `src/tempoWallet.ts`, `src/migrate.ts`, `src/activate.ts` | Setup: approving an access key in the Tempo Wallet, registering it on chain, and moving funds out of a local demo wallet     |
| `src/hints.md`                                            | Optional "tool map" of verified services (toggle in the UI)                                                                  |
| `src/server.ts`, `src/verify.ts`                          | Demo app: serves `site/`, run API + SSE, history, on-chain verification                                                      |
| `src/runview.ts`                                          | Shapes runs for the UI (cards, totals, run pages); shared by the server and the static export                                |
| `site/`                                                   | The UI. Live (`pnpm dev`): Try it, History, How this works. Static (`pnpm run export`): a read-only gallery of recorded runs |
| `scripts/export-site.ts`                                  | Exports curated runs (`site.config.json`) plus `site/` as a static site for static hosting                                   |
