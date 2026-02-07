# Stream

A streaming payment channel example demonstrating pay-per-token LLM responses using mpay on Tempo Moderato testnet.

The server issues 402 challenges for a stream intent. The client opens an on-chain payment channel, deposits alphaUSD, and submits signed cumulative vouchers as credentials. The server verifies vouchers and streams SSE tokens.

## Setup

```bash
npx gitpick wevm/mpay/examples/stream
pnpm i
```

## Usage

Start the server:

```bash
pnpm dev
```

In a separate terminal, run the client:

```bash
pnpm client
pnpm client "What is the meaning of life?"
```

The client persists its private key and channel state in `.channel.json`. Delete this file to start fresh with a new account and channel.
