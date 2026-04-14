# Proposal: UCP API Improvements

Two new methods on `Mppx` to support non-HTTP-402 integrations (UCP, webhooks, queue consumers) where the server generates challenges and verifies credentials outside the request lifecycle.

## Problem

When using mppx in a UCP handler, you bypass `Mppx.create()`'s internal pipeline and hit two pain points:

1. **Challenge generation** — `Challenge.from()` / `Challenge.fromIntent()` bypass the method's schema transforms (e.g. `parseUnits`), so you manually convert amounts to base units. `mppx.charge()` does this for you, but returns a request handler, not a challenge.

2. **Credential verification** — No standalone verify. You manually deserialize the credential, HMAC-check the challenge, find the method, validate the payload schema, reconstruct request params in the right unit format, then call the undocumented `method.verify()`. That's 5 steps that `createMethodFn` already does internally.

## Proposed API

### `mppx.challenge.{method}.{intent}(opts)` — Challenge generation

Same options type and schema transforms as `mppx.{method}.{intent}()`, returns a `Challenge` object directly instead of a request handler.

```ts
const mppx = Mppx.create({
  methods: [tempo({ currency: USDC, recipient: '0x...' })],
  secretKey: process.env.MPP_SECRET_KEY,
})

// Returns a Challenge object (not a request handler)
const challenge = mppx.challenge.tempo.charge({
  amount: '25.92',           // human-readable — SDK applies parseUnits
  description: 'Order #123',
  expires: '2026-04-14T17:00:00Z',
})
```

**Type sketch:**

```ts
type Mppx<methods, transport> = {
  // ... existing fields ...

  challenge: {
    [name in methods[number]['name']]: {
      [mi in Extract<methods[number], { name: name }> as mi['intent']]: (
        options: MethodFn.Options<mi, NonNullable<mi['defaults']>>
      ) => Challenge.Challenge
    }
  }
}
```

**Implementation:** Extract lines 262–304 of `createMethodFn` (merge defaults → transform request → `Challenge.fromMethod`) into a standalone function. No new logic.

### `mppx.verifyCredential(credential)` — Single-call verification

Deserializes, HMAC-checks, matches the method, validates the payload, and calls `verify()`. Returns a `Receipt`.

```ts
// From a raw credential string (e.g. UCP instrument value)
const receipt = await mppx.verifyCredential('eyJjaGFsbGVuZ2...')

// Or from an already-parsed Credential object
const receipt = await mppx.verifyCredential(credential)
```

**Type sketch:**

```ts
type Mppx<methods, transport> = {
  // ... existing fields ...

  verifyCredential(
    credential: string | Credential.Credential
  ): Promise<Receipt.Receipt>
}
```

**Implementation:** Extract lines 329–435 of `createMethodFn` (HMAC verify → pinned field check → expiry check → schema validate → `verify()`) into a standalone function. Method resolution uses `credential.challenge.method` + `credential.challenge.intent` to find the registered handler, same dispatch logic as `compose`.

Key insight: the challenge already contains the request params (HMAC-bound), so the server doesn't re-supply them.

## UCP Integration Before/After

**Before:**
```ts
// Challenge generation — manual base-unit conversion
const challenge = Challenge.from({
  realm: 'merchant.example.com',
  method: 'tempo',
  intent: 'charge',
  secretKey: process.env.MPP_SECRET_KEY,
  request: {
    amount: '25920000',     // you convert to base units
    currency: '0x20c0...00',
    recipient: account.address,
    decimals: 6,            // you supply this
    methodDetails: { chainId: 42431, feePayer: true },
  },
})

// Verification — 5 manual steps
const cred = Credential.deserialize(instrumentCredential)
if (!Challenge.verify(cred.challenge, { secretKey })) throw new Error('bad HMAC')
const method = mppx.methods.find(m => m.name === cred.challenge.method)
method.schema.credential.payload.parse(cred.payload)
const receipt = await method.verify({ credential: cred, request: { ... } })
```

**After:**
```ts
// Challenge generation — same input shape as mppx.tempo.charge()
const challenge = mppx.challenge.tempo.charge({
  amount: '25.92',
  description: 'Order #123',
})

// Verification — one call
const receipt = await mppx.verifyCredential(instrumentCredential)
```
