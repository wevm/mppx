---
name: mpp-agent-setup
description: Set up and run the mpp-agent demo locally. It's an AI agent whose only integration is a stablecoin wallet that pays for tools over MPP (HTTP 402). Use when a user asks to try, install, set up or run mpp-agent.
---

# Set up the mpp-agent demo

You are helping a user run the mpp-agent demo on their own machine. The agent pays from **their own Tempo Wallet**, through an access key they approve with a spending limit and expiry. Be brief and friendly, and do the steps for them.

## Rules

- **Never print, log, copy or ask for any key.** `pnpm run setup` stores the access key in the macOS keychain or in `~/.mpp-agent/access-key.json` (mode 600); an older local demo wallet key lives in the keychain or `~/.mpp-agent/key`. Don't read those files or keychain items.
- **Never approve or send funds yourself.** Approving the access key happens in the user's Tempo Wallet with their passkey. Funding and moving funds are the user's decisions: ask, and only run `pnpm run migrate -- --yes` after they say yes.
- Don't change budgets, caps or the side-effect policy unless the user explicitly asks.

## Steps

1. **Check prerequisites:** `node --version` must be ≥ 22, and `git` and `pnpm --version` must work. If Node is older, suggest `brew install node` (or the user's usual tool) and stop until it's fixed. If pnpm is missing, suggest `npm install -g pnpm`.
2. **Download and install** (skip the download if `~/mpp-agent` already exists). This copies just the example out of the mppx repo:
   ```bash
   npx gitpick wevm/mppx/tree/main/examples/mpp-agent ~/mpp-agent
   cd ~/mpp-agent && pnpm i
   ```
   Run every later command from `~/mpp-agent`. Use `pnpm run setup`, not `pnpm setup` (a built-in pnpm command).
3. **Approve the agent in their Tempo Wallet:** run `pnpm run setup` (defaults: $5 limit, 7 days; ask if they want different, e.g. `pnpm run setup -- --limit=10 --days=30`). On macOS it opens wallet.tempo.xyz; always show the user the printed **link and confirmation code** and ask them to approve with their passkey. Setup waits up to 5 minutes, then prints the Tempo Wallet address, the access key, the limit and the expiry, and registers the key on chain (one transaction the wallet pays for, fee under a cent; it prints the link). Show those lines exactly as printed.
4. **If setup says it found a local demo wallet** (from an earlier version), it shows the balance and how much can move after the network fee. Ask the user whether to move it to their Tempo Wallet. If yes, run `pnpm run migrate -- --yes` and show the explorer link and new balances. Once it's empty, offer `pnpm run setup -- --forget-local-key` to delete the old key (it refuses while funds remain). If they say no, leave it: the agent uses the Tempo Wallet from now on, and they can run `pnpm run migrate` later.
5. **Make sure the Tempo Wallet has USDC.e** (setup prints its balance). If it's empty, help them add **$2–5 of USDC.e on Tempo mainnet**: the wallet app at https://wallet.tempo.xyz, or `! tempo wallet fund` (card or Apple Pay; install the CLI with `curl -fsSL https://tempo.xyz/install | bash`). Suggest the `!` prefix so it runs in this session.
6. **Start it:** run `pnpm dev` in the background, then open http://127.0.0.1:3000 (`open http://127.0.0.1:3000` on macOS).
7. **Hand off.** Tell them:
   - Click a suggested chip (e.g. "🌤 Plan my Saturday in Lisbon") and press Run. They'll watch each paid call, its price and its on-chain transaction live.
   - "🧭 Tool map" on is more reliable. Off means the agent discovers every tool from public directories.
   - Runs cost about $0.15–0.70, from their Tempo Wallet. The header shows the balance and the allowance left on the agent's key. History shows past runs, and **Verify on-chain** re-checks every payment against the chain.
   - They can revoke the agent's key any time in the Tempo Wallet app.
   - Stop the server with Ctrl-C, or by killing the `pnpm dev` process.

## Troubleshooting

- **`No wallet yet`:** run `pnpm run setup`.
- **`pnpm dev` says "local demo wallet (legacy mode)":** no access key is stored yet. Run `pnpm run setup` (step 3).
- **Payments are blocked for the allowance, or the key expired:** `pnpm run setup -- --reauthorize` approves a new key.
- **The approval timed out:** run `pnpm run setup` again; each run gets a new code.
- **A payment fails with `fee-sponsored transaction keyAuthorization is not allowed`:** the key isn't registered on chain yet. Run `pnpm run setup -- --activate-only` (the Tempo Wallet needs a little USDC.e for the fee).
- **The balance stays $0:** make sure they added **USDC.e** on **Tempo mainnet** (chain 4217), not Base or Ethereum.
- **Port 3000 is in use:** `PORT=3001 pnpm dev`.
