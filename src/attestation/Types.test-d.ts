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

test('types: middleware policy receives evidence from its verifier map', () => {
  const tapVerifier: Attestation.Verifier<Tap.Evidence> = {
    verify: () => ({ status: 'absent' }),
  }
  const verifiers: { readonly [protocol in typeof Tap.Constants.protocol]: typeof tapVerifier } = {
    [Tap.Constants.protocol]: tapVerifier,
  }

  Attestation.Server.middleware(async () => new Response(), {
    policy({ evidence }) {
      expectTypeOf(evidence).toEqualTypeOf<readonly Tap.Evidence[]>()
      return { allow: true }
    },
    verifiers,
  })
})
