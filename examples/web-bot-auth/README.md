# Web Bot Auth with MPP

A client and server combining the Web Bot Auth HTTPS-directory profile with an automatic MPP
payment flow. The client signs both the initial request and the payment retry with Ed25519. The
server verifies the bot identity before issuing or accepting an MPP payment challenge.

```bash
npx gitpick wevm/mppx/examples/web-bot-auth
pnpm i
pnpm dev
```

The example generates a temporary keypair and prints an authenticated response:

```text
challenge.received demo/charge
credential.created demo/charge
payment.response 200
200 {
  payment: 'paid'
}
```

[`src/client.ts`](./src/client.ts) passes the Web Bot Auth signer directly to `Mppx.create()` via
`attestation`. This keeps automatic 402 handling while giving every HTTP attempt fresh `Signature-Agent`,
`Signature-Input`, and `Signature` headers. The demo registers `onChallengeReceived`,
`onCredentialCreated`, and `onPaymentResponse` hooks to expose the payment lifecycle.

[`src/server.ts`](./src/server.ts) passes its trusted Web Bot Auth verifier to the server's
`Mppx.create()` `attestation` map. Mppx requires it before issuing or accepting a payment challenge.
The example method in
[`src/method.ts`](./src/method.ts) uses a local credential so the full flow runs without a wallet or
network. Replace it with a Tempo, Stripe, or custom production payment method.

The verifier does not fetch the caller-controlled `Signature-Agent` URL. Its `keyResolver` first
applies application trust policy, then returns the public key. A production resolver can query an
allowlisted directory after applying the same origin checks.

`Attestation.NonceStore.memory()` is suitable only for this single-process demo. Multi-instance
deployments need shared storage with atomic insert-if-absent and expiry semantics. Web Bot Auth
proves which bot key signed the request; the application must separately decide what the bot is
authorized to do.
