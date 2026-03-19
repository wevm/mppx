import { Methods } from 'mppx/whop'
import { describe, expect, expectTypeOf, test } from 'vitest'

describe('charge', () => {
  test('has correct name and intent', () => {
    expect(Methods.charge.intent).toBe('charge')
    expect(Methods.charge.name).toBe('whop')
  })

  test('types: intent is literal', () => {
    expectTypeOf(Methods.charge.intent).toEqualTypeOf<'charge'>()
  })

  test('types: name is literal', () => {
    expectTypeOf(Methods.charge.name).toEqualTypeOf<'whop'>()
  })

  test('schema: validates valid request', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: 5.0,
      currency: 'usd',
      companyId: 'biz_xxx',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates request with description', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: 1.0,
      currency: 'usd',
      companyId: 'biz_xxx',
      description: 'Fortune cookie',
    })
    expect(result.success).toBe(true)
  })

  test('schema: rejects invalid request (missing companyId)', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: 5.0,
      currency: 'usd',
    })
    expect(result.success).toBe(false)
  })

  test('schema: validates paymentId payload', () => {
    const result = Methods.charge.schema.credential.payload.safeParse({
      paymentId: 'pay_hJ5qYeTJlbirjW',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates payload with externalId', () => {
    const result = Methods.charge.schema.credential.payload.safeParse({
      paymentId: 'pay_hJ5qYeTJlbirjW',
      externalId: 'order_123',
    })
    expect(result.success).toBe(true)
  })

  test('schema: rejects invalid payload (missing paymentId)', () => {
    const result = Methods.charge.schema.credential.payload.safeParse({
      spt: 'spt_test_123',
    })
    expect(result.success).toBe(false)
  })
})
