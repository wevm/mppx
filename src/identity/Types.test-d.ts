import { Mppx as ClientMppx } from 'mppx/client'
import * as Tap from 'mppx/extensions/identity/tap'
import * as Identity from 'mppx/identity'
import { expectTypeOf, test } from 'vp/test'

test('types: results are typed by the verifier used to look them up', () => {
  const tap = Tap.Server.verifier({
    keyResolver: () => undefined,
    nonceStore: Identity.Store.memory(),
  })
  const results = {} as Identity.Results
  expectTypeOf(results.get(tap)).toEqualTypeOf<Tap.VerifiedRequest | undefined>()
  expectTypeOf(Identity.anyOf(tap, tap)).toMatchTypeOf<Identity.Verifier>()

  // @ts-expect-error anyOf needs at least two verifiers
  Identity.anyOf(tap)
})

test('types: TAP provers require an explicit origin scope', () => {
  const key = {} as CryptoKey
  expectTypeOf(
    Tap.Client.prover({ intent: 'payment', key, keyId: 'agent', scope: '*' }),
  ).toEqualTypeOf<Identity.Prover>()

  // @ts-expect-error scope must be chosen explicitly
  Tap.Client.prover({ intent: 'payment', key, keyId: 'agent' })

  // @ts-expect-error replay storage must be chosen explicitly
  Tap.Server.verifier({ keyResolver: () => undefined })
})

test('types: client identity is HTTP-only', () => {
  ClientMppx.create({ identity: [{} as Identity.Prover], methods: [], polyfill: false })
})
