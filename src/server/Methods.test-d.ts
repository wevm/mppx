import { evm, stripe, tempo } from 'mppx/server'
import { expectTypeOf, test } from 'vp/test'

import type { StripeClient } from '../stripe/internal/types.js'

test('all server method constructors expose typed canOffer hooks', () => {
  tempo.charge({
    canOffer({ input, request }) {
      expectTypeOf(input).toEqualTypeOf<Request>()
      expectTypeOf(request.amount).toEqualTypeOf<string>()
      expectTypeOf(request.methodDetails?.chainId).toEqualTypeOf<number | undefined>()
      return true
    },
  })

  tempo.session({
    canOffer({ input, request }) {
      expectTypeOf(input).toEqualTypeOf<Request>()
      expectTypeOf(request.amount).toEqualTypeOf<string>()
      expectTypeOf(request.methodDetails?.chainId).toEqualTypeOf<number | undefined>()
      return true
    },
  })

  tempo.subscription({
    canOffer({ input, request }) {
      expectTypeOf(input).toEqualTypeOf<Request>()
      expectTypeOf(request.amount).toEqualTypeOf<string>()
      expectTypeOf(request.periodUnit).toEqualTypeOf<'dev_second' | 'day' | 'week'>()
      return true
    },
    resolve: async () => null,
  })

  evm.charge({
    canOffer({ input, request }) {
      expectTypeOf(input).toEqualTypeOf<Request>()
      expectTypeOf(request.amount).toEqualTypeOf<string>()
      expectTypeOf(request.methodDetails.chainId).toEqualTypeOf<number>()
      return true
    },
    currency: evm.assets.base.USDC,
    recipient: '0x0000000000000000000000000000000000000001',
    settle: async () => ({ reference: '0x01' }),
  })

  stripe.charge({
    canOffer({ input, request }) {
      expectTypeOf(input).toEqualTypeOf<Request>()
      expectTypeOf(request.amount).toEqualTypeOf<string>()
      expectTypeOf(request.methodDetails.networkId).toEqualTypeOf<string>()
      return true
    },
    client: {} as StripeClient,
    networkId: 'internal',
    paymentMethodTypes: ['card'],
  })
})

test('provider convenience constructors forward canOffer', () => {
  evm({
    canOffer({ request }) {
      expectTypeOf(request.methodDetails.chainId).toEqualTypeOf<number>()
      return true
    },
    currency: evm.assets.base.USDC,
    recipient: '0x0000000000000000000000000000000000000001',
    settle: async () => ({ reference: '0x01' }),
  })

  stripe({
    canOffer({ request }) {
      expectTypeOf(request.methodDetails.networkId).toEqualTypeOf<string>()
      return true
    },
    client: {} as StripeClient,
    networkId: 'internal',
    paymentMethodTypes: ['card'],
  })

  tempo({
    canOffer({ input, request }) {
      expectTypeOf(input).toEqualTypeOf<Request>()
      expectTypeOf(request.amount).toEqualTypeOf<string>()
      return true
    },
  })
})
