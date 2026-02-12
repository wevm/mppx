import { MethodIntents } from 'mpay/stripe'
import { describe, expect, expectTypeOf, test } from 'vitest'

describe('charge', () => {
  test('has correct name and method', () => {
    expect(MethodIntents.charge.name).toBe('charge')
    expect(MethodIntents.charge.method).toBe('stripe')
  })

  test('types: name is literal', () => {
    expectTypeOf(MethodIntents.charge.name).toEqualTypeOf<'charge'>()
  })

  test('types: method is literal', () => {
    expectTypeOf(MethodIntents.charge.method).toEqualTypeOf<'stripe'>()
  })

  test('schema: validates valid request', () => {
    const result = MethodIntents.charge.schema.request.safeParse({
      amount: '1',
      currency: 'usd',
      decimals: 2,
      expires: '2025-02-05T12:05:00Z',
      networkId: 'profile_123',
    })
    expect(result.success).toBe(true)
  })

  test('schema: rejects invalid request', () => {
    const result = MethodIntents.charge.schema.request.safeParse({
      amount: '1',
    })
    expect(result.success).toBe(false)
  })

  test('schema: validates spt payload', () => {
    const result = MethodIntents.charge.schema.credential.payload.safeParse({
      spt: 'spt_test_123',
    })
    expect(result.success).toBe(true)
  })

  test('schema: rejects invalid payload', () => {
    const result = MethodIntents.charge.schema.credential.payload.safeParse({
      signature: '0x...',
    })
    expect(result.success).toBe(false)
  })
})
