# Human-backed agents with World AgentKit

A paid API that gives agents backed by a World ID-verified human their first report free, then charges 0.01 pathUSD on Tempo testnet. It uses World's AgentKit: the agent signs each request with its wallet, and the server looks the wallet up in AgentBook, an on-chain registry on World Chain that maps agent wallets to anonymous human IDs. The header and message match x402's AgentKit extension, so a wallet registered for x402 works here too.

## Setup

```bash
npx gitpick wevm/mppx/examples/world-agentkit
pnpm i
```

## Usage

Register the agent wallet once with a World ID proof from World App:

```bash
pnpm client                                  # creates .agent-key and prints the wallet
npx @worldcoin/agentkit-cli register <agent-wallet>
```

Then start the server and run the client:

```bash
pnpm server
pnpm client
```

The first report is free and shows the agent's anonymous human ID; the second pays. An unregistered wallet pays for both.

### Without World App

Fork World Chain with [Anvil](https://getfoundry.sh) and write the registration into the real AgentBook contract on the fork:

```bash
anvil --fork-url https://worldchain-mainnet.g.alchemy.com/public
pnpm register                                # registers the wallet in .agent-key on the fork
WORLD_RPC_URL=http://127.0.0.1:8545 pnpm server
pnpm client
```

## How it works

- [`src/client.ts`](./src/client.ts) passes `World.Client.prover({ account, scope })` to `Mppx.create()`. Every in-scope request gets an `agentkit` header: a SIWE (CAIP-122) message for the request's host, signed by the wallet.
- [`src/server.ts`](./src/server.ts) creates `World.Server.verifier({ nonceStore })`. `verify(request)` checks the message's domain, lifetime and signature, claims its nonce once, then reads `lookupHuman` from AgentBook. A valid result carries `humanId`, so the free report is counted per human, not per agent.
- Smart accounts work too: pass the account (such as a Coinbase Smart Wallet or Safe) with `chainId` and `type: 'eip1271'`. The server verifies ERC-1271 and ERC-6492 signatures on World Chain by default, and on other chains you add through `rpcUrls`.
- To require a human-backed agent instead, pass the verifier to a route: `mppx.charge({ amount, identity: [human] })`. Unsigned requests then get `401` and unregistered wallets `403` before any 402.
