import { Methods } from 'mppx/stripe'
import { describe, expect, expectTypeOf, test, vi } from 'vp/test'

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
      paymentIntentOptions: {
        customer: 'cus_123',
        hooks: { inputs: { tax: { calculation: 'taxcalc_123' } } },
        metadata: { order: '123' },
        receipt_email: 'customer@example.com',
      },
    })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data).not.toHaveProperty('paymentIntentOptions')
  })

  test('schema: accepts a PaymentIntent options resolver without invoking it', () => {
    const paymentIntentOptions = vi.fn(() => ({ customer: 'cus_123' }))
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: 'usd',
      decimals: 2,
      networkId: 'profile_123',
      paymentIntentOptions,
      paymentMethodTypes: ['card'],
    })

    expect(result.success).toBe(true)
    expect(paymentIntentOptions).not.toHaveBeenCalled()
    if (result.success) expect(result.data).not.toHaveProperty('paymentIntentOptions')
  })

  test('schema: rejects invalid request', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
    })
    expect(result.success).toBe(false)
  })

  test('schema: accepts a customer without metadata', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: 'usd',
      decimals: 2,
      networkId: 'profile_123',
      paymentIntentOptions: { customer: 'cus_123' },
      paymentMethodTypes: ['card'],
    })

    expect(result.success).toBe(true)
  })

  test('schema: rejects an empty customer', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: 'usd',
      decimals: 2,
      networkId: 'profile_123',
      paymentIntentOptions: { customer: '' },
      paymentMethodTypes: ['card'],
    })

    expect(result.success).toBe(false)
  })

  test.each([{ hooks: { inputs: { tax: { calculation: '' } } } }, { receipt_email: '' }])(
    'schema: rejects empty PaymentIntent option strings',
    (paymentIntentOptions) => {
      const result = Methods.charge.schema.request.safeParse({
        amount: '1',
        currency: 'usd',
        decimals: 2,
        networkId: 'profile_123',
        paymentIntentOptions,
        paymentMethodTypes: ['card'],
      })

      expect(result.success).toBe(false)
    },
  )

  test('schema: requires decimals when no server default supplies it', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: 'usd',
      networkId: 'profile_123',
      paymentMethodTypes: ['card'],
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
