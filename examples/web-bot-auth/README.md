# Web Bot Auth with MPP

A client and server combining the Web Bot Auth HTTPS-directory profile with an automatic MPP
payment flow. The client signs both the initial request and the payment retry with Ed25519. The
server verifies the bot identity before issuing or accepting an MPP payment challenge.

```bash
npx gitpick wevm/mppx/examples/web-bot-auth
pnpm i
pnpm check:types
```

[`src/client.ts`](./src/client.ts) passes a Web Bot Auth prover to `Mppx.create()` via
`identity`, scoped to the origins that should receive the signature. Every in-scope HTTP attempt
gets fresh `Signature-Agent`, `Signature-Input`, and `Signature` headers.

[`src/server.ts`](./src/server.ts) creates a trusted Web Bot Auth verifier and requires it per route:
`mppx.charge({ amount, identity: [webBotAuth] })`. Routes without `identity` stay open. In a
handler, `result.identity.get(webBotAuth)` returns the verified key ID and directory.

The verifier does not fetch the caller-controlled `Signature-Agent` URL. Its `keyResolver` first
applies application trust policy, then returns the public key. A production resolver can query an
allowlisted directory after applying the same origin checks.

`Identity.Store.memory()` is suitable only for this single-process example. Multi-instance
deployments need shared storage with atomic insert-if-absent and expiry semantics. Web Bot Auth
proves which bot key signed the request; the application must separately decide what the bot is
authorized to do.
