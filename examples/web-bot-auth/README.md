# Web Bot Auth

A client and server using the Web Bot Auth HTTPS-directory profile. The client signs a request
with Ed25519. The server binds the signature to a trusted `Signature-Agent` origin and JWK
thumbprint, then rejects replayed nonces.

```bash
npx gitpick wevm/mppx/examples/web-bot-auth
pnpm i
pnpm dev
```

The example generates a temporary keypair and prints an authenticated response:

```text
200 {
  authenticated: true,
  bot: {
    keyId: '<RFC 7638 thumbprint>',
    signatureAgent: 'https://bot.example'
  }
}
```

[`src/client.ts`](./src/client.ts) creates the signer and wraps `fetch`, giving every HTTP attempt
fresh `Signature-Agent`, `Signature-Input`, and `Signature` headers. [`src/server.ts`](./src/server.ts)
creates the verifier and injects the application's trusted key-resolution policy.

The verifier does not fetch the caller-controlled `Signature-Agent` URL. Its `keyResolver` first
applies application trust policy, then returns the public key. A production resolver can query an
allowlisted directory after applying the same origin checks.

`Attestation.NonceStore.memory()` is suitable only for this single-process demo. Multi-instance
deployments need shared storage with atomic insert-if-absent and expiry semantics. Web Bot Auth
proves which bot key signed the request; the application must separately decide what the bot is
authorized to do.
