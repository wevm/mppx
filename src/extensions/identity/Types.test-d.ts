import { Attestation } from 'mppx/extensions/identity'
import type { SignatureAlgorithm, Signer, SigningKey } from 'mppx/extensions/identity'
import * as Tap from 'mppx/extensions/identity/tap'
import * as WebBotAuth from 'mppx/extensions/identity/web-bot-auth'
import type * as Identity from 'mppx/identity'
import { expectTypeOf, test } from 'vp/test'

test('types: Web Bot Auth and TAP share local and external signing keys', () => {
  expectTypeOf<WebBotAuth.Client.prover.Config['key']>().toEqualTypeOf<SigningKey>()
  expectTypeOf<Tap.Client.prover.Config['key']>().toEqualTypeOf<SigningKey>()
  const key = {
    algorithm: 'ed25519',
    sign: async (_bytes: Uint8Array) => new Uint8Array(64),
  } satisfies SigningKey
  expectTypeOf(
    WebBotAuth.Client.prover({
      key,
      keyId: 'A'.repeat(43),
      scope: '*',
      signatureAgent: 'https://agent.example',
    }),
  ).toEqualTypeOf<Identity.Prover>()
  expectTypeOf(
    Tap.Client.prover({
      key,
      keyId: 'agent',
      intent: 'payment',
      scope: '*',
    }),
  ).toEqualTypeOf<Identity.Prover>()
  expectTypeOf<Exclude<SigningKey, CryptoKey>['algorithm']>().toEqualTypeOf<SignatureAlgorithm>()
  expectTypeOf<Exclude<SigningKey, CryptoKey>['sign']>().toEqualTypeOf<
    (bytes: Uint8Array) => Promise<Uint8Array>
  >()
})

test('types: external signers require a supported algorithm and raw signature bytes', () => {
  const unsupported: SigningKey = {
    // @ts-expect-error only the supported RFC 9421 algorithms are accepted
    algorithm: 'hmac-sha256',
    sign: async () => new Uint8Array(64),
  }
  const encoded: SigningKey = {
    algorithm: 'ed25519',
    // @ts-expect-error external signers return raw bytes, not an encoded signature
    sign: async () => 'base64-encoded-signature',
  }
  void unsupported
  void encoded
})

test('types: Signer narrows to one algorithm', () => {
  expectTypeOf<Signer<'ed25519'>['algorithm']>().toEqualTypeOf<'ed25519'>()
  expectTypeOf<SigningKey<'ed25519'>>().toEqualTypeOf<CryptoKey | Signer<'ed25519'>>()
})

test('types: Attestation.sign accepts a CryptoKey or an Ed25519 signer only', () => {
  const claims = {} as Attestation.Claims
  const ed25519 = {
    algorithm: 'ed25519',
    sign: async (_bytes: Uint8Array) => new Uint8Array(64),
  } as const
  const rsa = {
    algorithm: 'rsa-pss-sha512',
    sign: async (_bytes: Uint8Array) => new Uint8Array(256),
  } as const
  expectTypeOf(Attestation.sign(claims, { key: ed25519, keyId: 'k' })).toEqualTypeOf<
    Promise<string>
  >()
  expectTypeOf(Attestation.sign(claims, { key: {} as CryptoKey, keyId: 'k' })).toEqualTypeOf<
    Promise<string>
  >()
  // @ts-expect-error attestations are EdDSA only
  void Attestation.sign(claims, { key: rsa, keyId: 'k' })
})
