import * as Attestation from 'mppx/attestation'
import * as Tap from 'mppx/attestation/tap'
import { expectTypeOf, test } from 'vp/test'

test('types: request signers compose with an optional shared context', () => {
  const first: Attestation.Signer<'first'> = {
    protocol: 'first',
    sign: (request) => request,
  }
  const second: Attestation.Signer<'second'> = {
    protocol: 'second',
    sign: (request) => request,
  }
  const signer = Attestation.Client.composeSigners(first, second)

  expectTypeOf(signer).toMatchTypeOf<Attestation.Signer>()
  expectTypeOf<Parameters<typeof signer.sign>[1]>().toEqualTypeOf<
    Attestation.SigningContext | undefined
  >()

  // @ts-expect-error at least one signer is required
  Attestation.Client.composeSigners()
})

test('types: server verification preserves each protocol value', () => {
  const tapVerifier: Attestation.Verifier<Tap.VerifiedRequest> = {
    verify: () => ({ status: 'absent' }),
  }
  const verifiers = { tap: tapVerifier } as const
  const verification = Attestation.Server.verify(
    new Request('https://merchant.example/resource'),
    verifiers,
  )

  expectTypeOf<Awaited<typeof verification>['tap']>().toEqualTypeOf<
    Attestation.Verification<Tap.VerifiedRequest>
  >()
})

test('types: server verifiers require explicit replay storage and expose the algorithm', () => {
  const nonceStore = Attestation.NonceStore.memory()
  expectTypeOf(nonceStore).toEqualTypeOf<Attestation.NonceStore.Store>()

  Tap.Server.verifier({
    keyResolver({ algorithm }) {
      expectTypeOf(algorithm).toEqualTypeOf<Attestation.SignatureAlgorithm>()
      return undefined
    },
    nonceStore,
  })

  // @ts-expect-error replay storage must be chosen explicitly
  Tap.Server.verifier({ keyResolver: () => undefined })
})
