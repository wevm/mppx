import type { Account } from 'viem'
import { describe, expectTypeOf, test } from 'vp/test'

import * as Receipt from '../Receipt.js'
import { charge } from '../tempo/client/Charge.js'
import * as Fetch from './internal/Fetch.js'
import * as Mppx from './Mppx.js'
import * as PaidResponse from './PaidResponse.js'

describe('PaidResponse', () => {
  test('view and validate preserve Response', () => {
    const response = new Response('{}')
    expectTypeOf(PaidResponse.view(response).response).toEqualTypeOf<Response>()
    expectTypeOf(PaidResponse.view(response).receipt).toEqualTypeOf<Receipt.Receipt | undefined>()
    expectTypeOf(PaidResponse.validate(response, async () => undefined)).toEqualTypeOf<
      Promise<Response>
    >()
  })

  test('validator payload includes optional payment evidence', () => {
    const method = charge()
    const fetch = Fetch.from({
      methods: [method],
      validateResponse: async (payload) => {
        expectTypeOf(payload.response).toEqualTypeOf<Response>()
        expectTypeOf(payload.receipt).toEqualTypeOf<Receipt.Receipt | undefined>()
        expectTypeOf(payload.credential).toEqualTypeOf<string | undefined>()
        expectTypeOf(payload.method?.intent).toEqualTypeOf<'charge' | undefined>()
      },
    })
    expectTypeOf(fetch).returns.toMatchTypeOf<Promise<Response>>()
  })

  test('Mppx.create accepts validateResponse', () => {
    const mppx = Mppx.create({
      methods: [charge({ account: {} as Account })],
      polyfill: false,
      validateResponse: async ({ response, receipt }) => {
        expectTypeOf(response).toEqualTypeOf<Response>()
        expectTypeOf(receipt).toEqualTypeOf<Receipt.Receipt | undefined>()
      },
    })
    expectTypeOf(mppx.fetch).returns.toMatchTypeOf<Promise<Response>>()
  })
})
