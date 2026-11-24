import { Attestation } from 'mppx/extensions/identity'
import type { Signer, SigningKey } from 'mppx/extensions/identity'
import * as Tap from 'mppx/extensions/identity/tap'
import * as WebBotAuth from 'mppx/extensions/identity/web-bot-auth'
import * as World from 'mppx/extensions/identity/world'
import type * as Identity from 'mppx/identity'
import { expectTypeOf, test } from 'vp/test'

const signer = {
  publicKey: {} as CryptoKey,
  sign: async ({ payload }: { readonly payload: Uint8Array }) => payload,
} satisfies Signer
const pair = {} as CryptoKeyPair

test('types: every signing site takes the same SigningKey', () => {
  expectTypeOf<SigningKey>().toEqualTypeOf<CryptoKeyPair | Signer>()
  expectTypeOf<WebBotAuth.Client.prover.Config['key']>().toEqualTypeOf<SigningKey>()
  expectTypeOf<Tap.Client.prover.Config['key']>().toEqualTypeOf<SigningKey>()
  expectTypeOf<Parameters<typeof Attestation.sign>[1]['key']>().toEqualTypeOf<SigningKey>()
  expectTypeOf<World.Issuer.create.Config['signingKey']>().toEqualTypeOf<SigningKey>()
  expectTypeOf<Signer['sign']>().toEqualTypeOf<
    (parameters: { readonly payload: Uint8Array }) => Promise<Uint8Array>
  >()
})

test('types: provers accept key pairs and signers', () => {
  for (const key of [pair, signer]) {
    expectTypeOf(
      WebBotAuth.Client.prover({ key, scope: '*', signatureAgent: 'https://agent.example' }),
    ).toEqualTypeOf<Identity.Prover>()
    expectTypeOf(
      Tap.Client.prover({ key, keyId: 'agent', intent: 'payment', scope: '*' }),
    ).toEqualTypeOf<Identity.Prover>()
    expectTypeOf(Attestation.sign({} as Attestation.Claims, { key })).toEqualTypeOf<
      Promise<string>
    >()
  }
})

test('types: the old shapes are rejected', () => {
  const privateKey = {} as CryptoKey
  // @ts-expect-error a private key alone is no longer a signing key
  WebBotAuth.Client.prover({ key: privateKey, scope: '*', signatureAgent: 'https://a.example' })
  WebBotAuth.Client.prover({
    key: pair,
    // @ts-expect-error the Web Bot Auth keyid is derived from the public key
    keyId: 'A'.repeat(43),
    scope: '*',
    signatureAgent: 'https://agent.example',
  })
  // @ts-expect-error a Signer needs its public key
  const withoutPublicKey: SigningKey = { sign: signer.sign }
  const encoded: SigningKey = {
    publicKey: signer.publicKey,
    // @ts-expect-error signers return raw bytes, not an encoded signature
    sign: async () => 'base64-encoded-signature',
  }
  void withoutPublicKey
  void encoded
})
