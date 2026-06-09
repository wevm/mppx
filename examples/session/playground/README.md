# Tempo Session Playground

Browser playground for the TIP-1034 `tempo.session` flow.

This example is precompile-only. Choose one backend with
`VITE_TEMPO_NETWORK=localnet|moderato`. Localnet means a Docker Tempo node that
exposes TIP-1034. If the configured RPC returns no data for TIP-1034 ABI calls,
the UI reports that state and paid session actions fail with a 503.

```bash
docker run -d --name mppx-session-localnet -p 18545:54515 ghcr.io/tempoxyz/tempo:latest node --authrpc.port 54545 --datadir /tmp/mppx-session-localnet --dev --dev.block-time 200ms --dev.mnemonic 'test test test test test test test test test test test junk' --engine.disable-precompile-cache --engine.legacy-state-root --faucet.address 0x20c0000000000000000000000000000000000000 0x20c0000000000000000000000000000000000001 0x20c0000000000000000000000000000000000002 0x20c0000000000000000000000000000000000003 --faucet.amount 1000000000000 --faucet.enabled --faucet.private-key 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80 --http.addr 0.0.0.0 --http.api all --http.corsdomain '*' --http.port 54515 --port 54525 --ws.port 54535
VITE_TEMPO_NETWORK=localnet VITE_RPC_URL=http://localhost:18545 pnpm dev:example session/playground
VITE_TEMPO_NETWORK=moderato pnpm dev:example session/playground
```

Open the printed URL, fund the generated demo wallet, start a session, and
crank it with incremental clicks. On reload, the session manager automatically
uses same-route `HEAD` bootstrap plus its local channel store to hydrate from
server channel state before continuing or closing.
