# Tempo Subscription

Recurring access-key subscription for a news app. The server charges `0.10` pathUSD per day by resolving the user to `{ key, accessKey }`, returning that dynamic Tempo access key in the MPP challenge, then requiring a `keyAuthorization` scoped to that key.

The example keeps billing deterministic for local development: `activate` and `renew` simulate the transfer that a production app would submit with the resolved access key, then persist the subscription record and receipt.

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

1. Requests `/api/article` and receives a `402` challenge that includes the dynamic access key for `user-1` and the `monthly` plan.
2. Signs a `keyAuthorization` for that access key and activates the subscription.
3. Requests `/api/article` again, reusing the active subscription with the same access key.

## Test with mppx CLI

With the server running, use the `mppx` CLI to inspect the challenge:

```bash
pnpm mppx localhost:5173/api/article -H 'X-User-Id: user-1'
```
