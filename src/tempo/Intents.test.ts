import { describe, expect, expectTypeOf, test } from 'vitest'
import { authorize, charge, subscription } from './Intents.js'

describe('charge', () => {
  test('has correct name and method', () => {
    expect(charge.name).toBe('charge')
    expect(charge.method).toBe('tempo')
  })

  test('types: name is literal', () => {
    expectTypeOf(charge.name).toEqualTypeOf<'charge'>()
  })

  test('types: method is literal', () => {
    expectTypeOf(charge.method).toEqualTypeOf<'tempo'>()
  })

  test('schema: validates valid request', () => {
    const result = charge.schema.request.safeParse({
      amount: '1000000',
      currency: '0x20c0000000000000000000000000000000000001',
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates request with methodDetails', () => {
    const result = charge.schema.request.safeParse({
      amount: '1000000',
      currency: '0x20c0000000000000000000000000000000000001',
      expires: '2025-02-05T12:05:00Z',
      methodDetails: { chainId: 42431, feePayer: true },
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates request with memo', () => {
    const result = charge.schema.request.safeParse({
      amount: '1000000',
      currency: '0x20c0000000000000000000000000000000000001',
      expires: '2025-02-05T12:05:00Z',
      memo: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
    })
    expect(result.success).toBe(true)
  })

  test('schema: rejects invalid request', () => {
    const result = charge.schema.request.safeParse({
      amount: '1000000',
    })
    expect(result.success).toBe(false)
  })

  test('schema: validates transaction payload', () => {
    const result = charge.schema.credential.payload.safeParse({
      signature: '0x76f90100000000000000000000000000000000000000000000000000000000000000000000',
      type: 'transaction',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates hash payload', () => {
    const result = charge.schema.credential.payload.safeParse({
      hash: '0x1a2b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890',
      type: 'hash',
    })
    expect(result.success).toBe(true)
  })

  test('schema: rejects invalid payload type', () => {
    const result = charge.schema.credential.payload.safeParse({
      signature: '0x...',
      type: 'keyAuthorization',
    })
    expect(result.success).toBe(false)
  })
})

describe('authorize', () => {
  test('has correct name and method', () => {
    expect(authorize.name).toBe('authorize')
    expect(authorize.method).toBe('tempo')
  })

  test('types: name is literal', () => {
    expectTypeOf(authorize.name).toEqualTypeOf<'authorize'>()
  })

  test('types: method is literal', () => {
    expectTypeOf(authorize.method).toEqualTypeOf<'tempo'>()
  })

  test('schema: validates valid request', () => {
    const result = authorize.schema.request.safeParse({
      amount: '1000000',
      currency: '0x20c0000000000000000000000000000000000001',
      expires: '2025-02-05T12:05:00Z',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates request with optional recipient', () => {
    const result = authorize.schema.request.safeParse({
      amount: '1000000',
      currency: '0x20c0000000000000000000000000000000000001',
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates request with memo', () => {
    const result = authorize.schema.request.safeParse({
      amount: '1000000',
      currency: '0x20c0000000000000000000000000000000000001',
      expires: '2025-02-05T12:05:00Z',
      memo: '0xabcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates transaction payload', () => {
    const result = authorize.schema.credential.payload.safeParse({
      signature: '0x76f90100000000000000000000000000000000000000000000000000000000000000000000',
      type: 'transaction',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates keyAuthorization payload', () => {
    const result = authorize.schema.credential.payload.safeParse({
      signature: '0xf8b200000000000000000000000000000000000000000000000000000000000000000000',
      type: 'keyAuthorization',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates hash payload', () => {
    const result = authorize.schema.credential.payload.safeParse({
      hash: '0x9f8e7d6cabcdef1234567890abcdef1234567890abcdef1234567890abcdef12',
      type: 'hash',
    })
    expect(result.success).toBe(true)
  })
})

describe('subscription', () => {
  test('has correct name and method', () => {
    expect(subscription.name).toBe('subscription')
    expect(subscription.method).toBe('tempo')
  })

  test('types: name is literal', () => {
    expectTypeOf(subscription.name).toEqualTypeOf<'subscription'>()
  })

  test('types: method is literal', () => {
    expectTypeOf(subscription.method).toEqualTypeOf<'tempo'>()
  })

  test('schema: validates valid request', () => {
    const result = subscription.schema.request.safeParse({
      amount: '1000000',
      currency: '0x20c0000000000000000000000000000000000001',
      expires: '2025-12-31T23:59:59Z',
      period: 'month',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates request with methodDetails', () => {
    const result = subscription.schema.request.safeParse({
      amount: '1000000',
      currency: '0x20c0000000000000000000000000000000000001',
      expires: '2025-12-31T23:59:59Z',
      methodDetails: { chainId: 42431, validFrom: '2025-01-01T00:00:00Z' },
      period: 'month',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates request with memo', () => {
    const result = subscription.schema.request.safeParse({
      amount: '1000000',
      currency: '0x20c0000000000000000000000000000000000001',
      expires: '2025-12-31T23:59:59Z',
      memo: '0x0000000000000000000000000000000000000000000000000000000000000001',
      period: 'month',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates keyAuthorization payload', () => {
    const result = subscription.schema.credential.payload.safeParse({
      signature: '0xf8c100000000000000000000000000000000000000000000000000000000000000000000',
      type: 'keyAuthorization',
    })
    expect(result.success).toBe(true)
  })

  test('schema: rejects transaction payload', () => {
    const result = subscription.schema.credential.payload.safeParse({
      signature: '0x76f90100000000000000000000000000000000000000000000000000000000000000000000',
      type: 'transaction',
    })
    expect(result.success).toBe(false)
  })

  test('schema: rejects hash payload', () => {
    const result = subscription.schema.credential.payload.safeParse({
      hash: '0x1a2b3c4d...',
      type: 'hash',
    })
    expect(result.success).toBe(false)
  })
})
