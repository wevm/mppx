# Xquik

Look up X (Twitter) tweets, users, and articles without an API key — pay per call via MPP.

[Xquik](https://xquik.com) exposes 7 MPP-eligible endpoints for real-time X data. This example demonstrates both `charge` (fixed per-call) and `session` (per-result) payment intents.

```bash
npx gitpick wevm/mppx/examples/xquik
pnpm i
pnpm dev
```

## What it does

1. **Tweet lookup** (charge, $0.0003/call) — fetch a tweet by ID with engagement metrics
2. **Tweet search** (session, $0.0003/tweet) — search tweets by query, pay per result
3. **User lookup** (charge, $0.00036/call) — look up an X user profile by username

## Test with mppx CLI

```bash
pnpm mppx https://xquik.com/api/v1/x/tweets/1893456789012345678
pnpm mppx "https://xquik.com/api/v1/x/tweets/search?q=AI+agents&limit=5"
pnpm mppx https://xquik.com/api/v1/x/users/xquikcom
```

## All MPP-eligible Xquik endpoints

| Endpoint | Price | Intent |
|----------|-------|--------|
| `GET /api/v1/x/tweets/{id}` | $0.0003/call | charge |
| `GET /api/v1/x/tweets/search` | $0.0003/tweet | session |
| `GET /api/v1/x/users/{username}` | $0.00036/call | charge |
| `GET /api/v1/x/followers/check` | $0.002/call | charge |
| `GET /api/v1/x/articles/{tweetId}` | $0.002/call | charge |
| `POST /api/v1/x/media/download` | $0.0003/media | session |
| `GET /api/v1/trends` | $0.0009/call | charge |

## OpenClaw plugin

For AI agents, install the [TweetClaw](https://www.npmjs.com/package/@xquik/tweetclaw) OpenClaw plugin with MPP support:

```bash
openclaw plugins install @xquik/tweetclaw
openclaw config set plugins.entries.tweetclaw.config.tempoPrivateKey '0xYOUR_KEY'
```
