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

test('types: middleware policy receives evidence and outcomes from its verifier map', () => {
  const tapVerifier: Attestation.Verifier<Tap.Evidence> = {
    verify: () => ({ status: 'absent' }),
  }
  const verifiers: { readonly [protocol in typeof Tap.Constants.protocol]: typeof tapVerifier } = {
    [Tap.Constants.protocol]: tapVerifier,
  }

  Attestation.Server.middleware(async () => new Response(), {
    policy({ evidence, outcomes }) {
      expectTypeOf(evidence).toEqualTypeOf<readonly Tap.Evidence[]>()
      expectTypeOf(outcomes[Tap.Constants.protocol]).toEqualTypeOf<
        Attestation.Verification<Tap.Evidence>
      >()
      return { allow: true }
    },
    verifiers,
  })
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
