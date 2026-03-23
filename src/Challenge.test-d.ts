import { assertType, describe, expectTypeOf, test } from 'vitest'

import * as Challenge from './Challenge.js'
import { Method } from './index.js'
import * as Methods from './tempo/Methods.js'

const method = Method.toServer(Methods.charge, {
  async verify() {
    return {
      method: 'tempo',
      reference: '0x123',
      status: 'success' as const,
      timestamp: new Date().toISOString(),
    }
  },
})

describe('FromMethod', () => {
  test('extracts method and intent from method', () => {
    type Result = Challenge.FromMethods<[typeof method]>

    assertType<Result['method']>('tempo' as const)
    assertType<Result['intent']>('charge' as const)

    expectTypeOf<Result['request']>().toHaveProperty('amount')
    expectTypeOf<Result['request']>().toHaveProperty('currency')
  })
})

describe('from', () => {
  test('without method returns generic Challenge', () => {
    const challenge = Challenge.from({
      id: 'test',
      intent: 'charge',
      method: 'tempo',
      realm: 'api.example.com',
      request: { amount: '1000' },
    })

    expectTypeOf(challenge.method).toBeString()
    expectTypeOf(challenge.intent).toBeString()
  })

  test('with method narrows to FromMethod type', () => {
    const challenge = Challenge.from(
      {
        id: 'test',
        intent: 'charge',
        method: 'tempo',
        realm: 'api.example.com',
        request: { amount: '1000' },
      },
      { methods: [method] },
    )

    assertType<'tempo'>(challenge.method)
    assertType<'charge'>(challenge.intent)
    expectTypeOf(challenge.request).toHaveProperty('amount')
    expectTypeOf(challenge.request).toHaveProperty('currency')
  })
})

describe('fromResponse', () => {
  test('behavior: without method returns generic Challenge', () => {
    const response = new Response(null, { status: 402 })
    const challenge = Challenge.fromResponse(response)
    expectTypeOf(challenge.method).toEqualTypeOf<string>()
    expectTypeOf(challenge.intent).toEqualTypeOf<string>()
    expectTypeOf(challenge.request).toEqualTypeOf<{
      [x: string]: unknown
    }>()
  })

  test('behavior: method narrows type', () => {
    const response = new Response(null, { status: 402 })
    const challenge = Challenge.fromResponse(response, { methods: [method] })
    expectTypeOf(challenge.method).toEqualTypeOf<'tempo'>()
    expectTypeOf(challenge.intent).toEqualTypeOf<'charge'>()
    expectTypeOf(challenge.request).toHaveProperty('amount')
    expectTypeOf(challenge.request).toHaveProperty('currency')
  })
})
