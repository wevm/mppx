import { describe, expectTypeOf, test } from 'vitest'
import * as Challenge from './Challenge.js'
import * as Intents from './tempo/Intents.js'

describe('from', () => {
  test('returns Challenge with typed request', () => {
    const challenge = Challenge.from({
      id: 'test',
      intent: 'charge',
      method: 'tempo',
      realm: 'api.example.com',
      request: { amount: '1000' },
    })

    expectTypeOf(challenge.method).toBeString()
    expectTypeOf(challenge.intent).toBeString()
    expectTypeOf(challenge.request).toHaveProperty('amount')
  })
})

describe('fromResponse', () => {
  test('returns generic Challenge', () => {
    const response = new Response(null, { status: 402 })
    const challenge = Challenge.fromResponse(response)
    expectTypeOf(challenge.method).toEqualTypeOf<string>()
    expectTypeOf(challenge.intent).toEqualTypeOf<string>()
    expectTypeOf(challenge.request).toEqualTypeOf<{
      [x: string]: unknown
    }>()
  })

  test('narrows type with methods', () => {
    const response = new Response(null, { status: 402 })
    const challenge = Challenge.fromResponse(response, {
      methods: [Intents.charge],
    })
    expectTypeOf(challenge.method).toEqualTypeOf<'tempo'>()
    expectTypeOf(challenge.intent).toEqualTypeOf<'charge'>()
    expectTypeOf(challenge.request.amount).toEqualTypeOf<string>()
    expectTypeOf(challenge.request.recipient).toEqualTypeOf<string>()
  })
})

describe('deserialize', () => {
  test('narrows type with methods', () => {
    const challenge = Challenge.deserialize('Payment ...', {
      methods: [Intents.charge],
    })
    expectTypeOf(challenge.method).toEqualTypeOf<'tempo'>()
    expectTypeOf(challenge.intent).toEqualTypeOf<'charge'>()
  })
})

describe('fromHeaders', () => {
  test('narrows type with methods', () => {
    const headers = new Headers()
    const challenge = Challenge.fromHeaders(headers, {
      methods: [Intents.charge],
    })
    expectTypeOf(challenge.method).toEqualTypeOf<'tempo'>()
    expectTypeOf(challenge.intent).toEqualTypeOf<'charge'>()
  })
})
