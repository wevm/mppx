import { Mppx, stripe } from 'mppx/server'
import { expectTypeOf, test } from 'vp/test'

import type { StripeClient } from '../internal/types.js'
import type { charge as StripeCharge } from './Charge.js'

const client = {} as StripeClient
const secretKey = 'test-secret-key-test-secret-key-32'

test('accepts a typed constructor canOffer policy', () => {
  stripe.charge({
    client,
    canOffer({ input, request }) {
      expectTypeOf(input).toEqualTypeOf<Request>()
      expectTypeOf(request.amount).toEqualTypeOf<string>()
      expectTypeOf(request.currency).toEqualTypeOf<string>()
      expectTypeOf(request.methodDetails.networkId).toEqualTypeOf<string>()
      return request.amount !== '0'
    },
    networkId: 'internal',
    paymentMethodTypes: ['card'],
  })
})

test('requires request fields not configured as Stripe defaults', () => {
  const server = Mppx.create({
    methods: [
      stripe.charge({
        client,
        networkId: 'internal',
        paymentMethodTypes: ['card'],
      }),
    ],
    realm: 'api.example.com',
    secretKey,
  })

  // @ts-expect-error decimals is required unless the factory supplied it.
  void server.charge({ amount: '1', currency: 'usd' })
  void server.charge({ amount: '1', currency: 'usd', decimals: 2 })
})

test('allows request fields configured as Stripe defaults', () => {
  const server = Mppx.create({
    methods: [
      stripe.charge({
        client,
        decimals: 2,
        networkId: 'internal',
        paymentMethodTypes: ['card'],
      }),
    ],
    realm: 'api.example.com',
    secretKey,
  })

  void server.charge({ amount: '1', currency: 'usd' })
})

test('accepts a typed PaymentIntent options resolver', () => {
  const server = Mppx.create({
    methods: [
      stripe.charge({
        client,
        networkId: 'internal',
        paymentMethodTypes: ['card'],
      }),
    ],
    realm: 'api.example.com',
    secretKey,
  })

  void server.charge({
    amount: '1',
    currency: 'usd',
    decimals: 2,
    paymentIntentOptions({ challenge, credential, envelope, request }) {
      expectTypeOf(challenge.id).toEqualTypeOf<string>()
      expectTypeOf(credential.challenge.id).toEqualTypeOf<string>()
      expectTypeOf(envelope).toEqualTypeOf<
        import('mppx').Method.VerifiedChallengeEnvelope | undefined
      >()
      expectTypeOf(request).toEqualTypeOf<Record<string, unknown>>()
      return Promise.resolve({ metadata: { challenge_id: challenge.id } })
    },
  })
})

test('does not treat optional properties on widened config as defaults', () => {
  const parameters: StripeCharge.Parameters = {
    client,
    networkId: 'internal',
    paymentMethodTypes: ['card'],
  }
  const server = Mppx.create({
    methods: [stripe.charge(parameters)],
    realm: 'api.example.com',
    secretKey,
  })

  // @ts-expect-error a widened optional decimals property is not a guaranteed default.
  void server.charge({ amount: '1', currency: 'usd' })
  void server.charge({
    amount: '1',
    currency: 'usd',
    decimals: 2,
    networkId: 'internal',
    paymentMethodTypes: ['card'],
  })
})
