# Tempo Subscription

Recurring access-key subscription for a news app. The server charges `0.10` pathUSD per day by deriving the subscription key from the signed payer identity, returning a Tempo access key in the MPP challenge, then requiring a `keyAuthorization` scoped to that key.

The example opts into credential-required reuse, so access is keyed from the payer signature instead of a user-controlled header.

## Setup

```bash
npx gitpick wevm/mppx/examples/subscription
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
```

The client:

1. Requests `/api/article` and receives a `402` challenge with a server access key.
2. Signs a `keyAuthorization`; the server derives the subscription key from the recovered payer.
3. Requests `/api/article` again, signs a fresh credential, and reuses the active subscription without another charge.
4. Requests `/api/subscription`, signs the route challenge, and reads subscription state for the verified payer.

## Test with mppx CLI

With the server running, use the `mppx` CLI to inspect the challenge:

```bash
pnpm mppx localhost:5173/api/article
```
