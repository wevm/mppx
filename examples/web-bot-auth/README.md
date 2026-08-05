# Web Bot Auth with MPP

A client and server combining the Web Bot Auth HTTPS-directory profile with an automatic MPP
payment flow. The client signs both the initial request and the payment retry with Ed25519. The
server verifies the bot identity before issuing or accepting an MPP payment challenge.

```bash
npx gitpick wevm/mppx/examples/web-bot-auth
pnpm i
pnpm check:types
```

[`src/client.ts`](./src/client.ts) passes the Web Bot Auth signer directly to `Mppx.create()` via
`attestation` and configures Tempo as its payment method. This keeps automatic 402 handling while
giving every HTTP attempt fresh `Signature-Agent`, `Signature-Input`, and `Signature` headers.
The returned Mppx client exposes `fetch()` and the standard client lifecycle hooks.

[`src/server.ts`](./src/server.ts) passes its trusted Web Bot Auth verifier to the server's
`Mppx.create()` `attestation` map. Mppx requires it before issuing or accepting a payment challenge.
The returned Mppx server exposes the standard Tempo handlers, such as
`server.charge({ amount: '0' })`. A zero amount requests a proof credential without transferring
funds; use a positive amount to charge for a protected resource.

The verifier does not fetch the caller-controlled `Signature-Agent` URL. Its `keyResolver` first
applies application trust policy, then returns the public key. A production resolver can query an
allowlisted directory after applying the same origin checks.

`Attestation.Store.memory()` is suitable only for this single-process example. Multi-instance
deployments need shared storage with atomic insert-if-absent and expiry semantics. Web Bot Auth
proves which bot key signed the request; the application must separately decide what the bot is
authorized to do.
