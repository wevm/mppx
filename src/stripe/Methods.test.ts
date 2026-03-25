import { Methods } from 'mppx/stripe'
import { describe, expect, expectTypeOf, test } from 'vite-plus/test'

describe('charge', () => {
  test('has correct name and intent', () => {
    expect(Methods.charge.intent).toBe('charge')
    expect(Methods.charge.name).toBe('stripe')
  })

  test('types: intent is literal', () => {
    expectTypeOf(Methods.charge.intent).toEqualTypeOf<'charge'>()
  })

  test('types: name is literal', () => {
    expectTypeOf(Methods.charge.name).toEqualTypeOf<'stripe'>()
  })

  test('schema: validates valid request', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: 'usd',
      decimals: 2,
      expires: '2025-02-05T12:05:00Z',
      networkId: 'profile_123',
      paymentMethodTypes: ['card'],
      metadata: { example: 'metadata' },
    })
    expect(result.success).toBe(true)
  })

  test('schema: rejects invalid request', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
    })
    expect(result.success).toBe(false)
  })

  test('schema: validates spt payload', () => {
    const result = Methods.charge.schema.credential.payload.safeParse({
      spt: 'spt_test_123',
      externalId: 'client_order_789',
    })
    expect(result.success).toBe(true)
  })

  test('schema: rejects invalid payload', () => {
    const result = Methods.charge.schema.credential.payload.safeParse({
      signature: '0x...',
    })
    expect(result.success).toBe(false)
  })
})
