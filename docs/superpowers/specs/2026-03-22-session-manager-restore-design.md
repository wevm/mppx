# SessionManager Restore API Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:writing-plans after this spec is approved to create the implementation plan.

**Goal:** Add a minimal public API to `mppx` that lets callers restore an existing Tempo session channel into `SessionManager` after a process restart.

**Architecture:** Keep persistence ownership outside `mppx`. `SessionManager` gains a small restore surface that seeds its in-memory channel state from caller-provided data, then continues using the existing `fetch()` and `sse()` payment flow. The new API should not change default behavior for fresh sessions.

**Tech Stack:** TypeScript, Vitest, existing `mppx` Tempo session client.

---

## Problem

`SessionManager` currently stores all channel state in memory. After a client process restarts, a caller cannot resume a previously opened session channel even if it already knows the `channelId` and accepted cumulative amount. This forces callers to either open a new channel or reimplement the session lifecycle outside `mppx`.

That limitation is a poor fit for long-lived clients like desktop apps, background agents, and local payment proxies. These clients often have a persisted wallet or channel database and need to resume the exact session state that existed before restart.

## Non-Goals

- `mppx` will not read or write SQLite, Redis, files, or any other storage backend in this change.
- `mppx` will not add a generic persistence adapter abstraction in this change.
- `mppx` will not include OpenCode-specific request normalization or provider compatibility logic.
- `mppx` will not attempt to automatically validate restored state against on-chain state in this first iteration.

## Recommended API

Add a minimal restore input to `sessionManager(...)`.

Example shape:

```ts
const s = sessionManager({
  account,
  maxDeposit: '10',
  restore: {
    channelId,
    cumulativeAmount: 450000n,
    spent: 450000n,
  },
})
```

Recommended public type:

```ts
type Restore = {
  channelId: Hex.Hex
  cumulativeAmount: bigint
  spent?: bigint | undefined
}
```

Recommended semantics:

- `channelId` is required
- `cumulativeAmount` is required
- `spent` defaults to `cumulativeAmount`
- restored sessions are always treated as already-opened channels

This keeps the API declarative, avoids mutation after construction, and makes the restored state visible at initialization time.

## Why Constructor Restore Instead of injectChannel()

Three approaches were considered:

1. **Constructor restore (recommended)**
   - smallest and clearest API
   - declarative state initialization
   - avoids awkward post-construction mutation timing

2. **`injectChannel()` instance method**
   - workable, but more imperative
   - creates questions about when it is safe to call relative to `fetch()` / `sse()`

3. **Persistence adapter abstraction**
   - more reusable in theory
   - much larger API/design surface
   - unnecessary because callers can already load persisted state themselves

The constructor `restore` option is the smallest change that solves the real problem.

## Internal Design

`SessionManager` currently owns these private mutable fields:

- `channel`
- `lastChallenge`
- `lastUrl`
- `spent`

This change should seed restored session state during construction, but it should not promise to construct a partial `ChannelEntry` that omits required low-level fields like `salt`, `escrowContract`, or `chainId`.

Expected internal behavior:

- initialize `spent` to `restore.spent ?? restore.cumulativeAmount`
- keep enough restored metadata in `SessionManager` to bridge the first paid request into the existing `session()` method context
- ensure the first 402 retry can reuse the restored `channelId` and `cumulativeAmount` even if the server challenge does not include `methodDetails.channelId`
- leave `lastChallenge` and `lastUrl` unset until the next real request
- keep `sessionPlugin(...).onChannelUpdate(...)` behavior unchanged so future server-driven updates continue to overwrite the restored snapshot naturally

This preserves the current runtime model while allowing a caller to skip the “fresh session only” assumption.

## Reuse Bridge on First 402

This is the critical implementation requirement.

Restoring state into `SessionManager` is not enough unless the next 402 retry actually passes that state into the lower-level `session()` method when it creates the credential.

The implementation must define a bridge so that, on the first paid request after restore, credential creation uses:

- restored `channelId`
- restored `cumulativeAmount`

instead of assuming a new channel should be opened.

That bridge should work even when the challenge does not provide a recoverable `methodDetails.channelId`.

## Runtime Invariants

The restore input needs runtime validation, not only type validation.

Required invariants:

- `cumulativeAmount >= 0n`
- `spent >= 0n` when provided
- `spent <= cumulativeAmount`

If any invariant is violated, `sessionManager(...)` should throw immediately during construction.

## Behavior Rules

### `fetch()`

- restored sessions should be treated as already-opened channels
- the first paid request should reuse the restored channel rather than forcing a new open
- `cumulative` should report the restored amount immediately before any network call

### `sse()`

- SSE should use the restored `channelId` and `cumulativeAmount` when responding to `payment-need-voucher`
- receipt handling should continue to move `spent` forward based on accepted cumulative values

### `open()`

- if `opened === true`, `.open()` should remain a no-op just like an already-open session

### `close()`

- restored `spent` state should be used when constructing the close credential
- if no fresh request has happened since process restart and `lastChallenge` / `lastUrl` are still unset, `.close()` cannot proceed; this limitation should be documented rather than expanded in this first PR

## Validation Rules

The first version should keep validation intentionally small but explicit:

- reject missing `channelId` or `cumulativeAmount` at type level
- normalize `spent` to `cumulativeAmount` if omitted
- enforce non-negative runtime values
- enforce `spent <= cumulativeAmount`

The API should not perform deeper validation like “check chain state” or “verify deposit” in this first PR. Those are separate concerns and would expand the scope too much.

## Testing Strategy

Add targeted tests to `src/tempo/client/SessionManager.test.ts`.

Required coverage:

1. session creation with restore state
   - `channelId` is exposed immediately
   - `cumulative` matches restored value
   - restored session reports `opened === true`

2. `fetch()` with restored state
   - request path reuses restored session behavior
   - include a case where the server challenge does not expose `methodDetails.channelId`
   - no regression for non-restored sessions

3. `sse()` with restored state
   - `payment-need-voucher` uses restored `channelId`
   - voucher creation advances from restored `cumulativeAmount`

4. `close()` with restored state
   - close credential uses restored `spent` / cumulative state after a fresh request has provided `lastChallenge`

5. restore validation
   - rejects negative `cumulativeAmount`
   - rejects negative `spent`
   - rejects `spent > cumulativeAmount`

## Documentation Changes

Update the `SessionManager` docs/comments to describe:

- the new `restore` option
- its intended use for process restarts and persisted callers
- that persistence remains the caller’s responsibility
- that `.close()` still requires a fresh request after restart so `lastChallenge` / `lastUrl` exist

If there is a public docs page or example for `tempo.sessionManager`, add a small example showing a restored session.

## Risks

- callers may restore stale state; this API makes that possible intentionally, so documentation must be explicit that callers own correctness of persisted inputs
- adding too much validation now would turn this into a much larger feature

## Out of Scope Follow-Ups

Potential future work after this lands:

- a dedicated `injectChannel()` helper if maintainers prefer that API shape
- persistence adapters for file/Redis/custom stores
- optional on-chain reconciliation for restored channels
- higher-level proxy/client examples for long-lived local payment daemons

## Upstream Positioning

This should be presented upstream as a generic client-resumption feature for long-lived session-based clients, not as an OpenCode-specific change. OpenCode remains an example consumer, but the underlying need applies to any restarted client that wants to reuse an existing Tempo payment channel.
