import { MethodIntents } from 'mppx/tempo'
import { describe, expect, expectTypeOf, test } from 'vitest'

describe('charge', () => {
  test('has correct name and method', () => {
    expect(MethodIntents.charge.name).toBe('charge')
    expect(MethodIntents.charge.method).toBe('tempo')
  })

  test('types: name is literal', () => {
    expectTypeOf(MethodIntents.charge.name).toEqualTypeOf<'charge'>()
  })

  test('types: method is literal', () => {
    expectTypeOf(MethodIntents.charge.method).toEqualTypeOf<'tempo'>()
  })

  test('schema: validates valid request', () => {
    const result = MethodIntents.charge.schema.request.safeParse({
      amount: '1',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates request with methodDetails', () => {
    const result = MethodIntents.charge.schema.request.safeParse({
      amount: '1',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      chainId: 42431,
      feePayer: true,
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates request with memo', () => {
    const result = MethodIntents.charge.schema.request.safeParse({
      amount: '1',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      memo: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
    })
    expect(result.success).toBe(true)
  })

  test('schema: rejects invalid request', () => {
    const result = MethodIntents.charge.schema.request.safeParse({
      amount: '1',
    })
    expect(result.success).toBe(false)
  })

  test('schema: validates transaction payload', () => {
    const result = MethodIntents.charge.schema.credential.payload.safeParse({
      signature: '0x76f90100000000000000000000000000000000000000000000000000000000000000000000',
      type: 'transaction',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates hash payload', () => {
    const result = MethodIntents.charge.schema.credential.payload.safeParse({
      hash: '0x1a2b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890',
      type: 'hash',
    })
    expect(result.success).toBe(true)
  })

  test('schema: rejects invalid payload type', () => {
    const result = MethodIntents.charge.schema.credential.payload.safeParse({
      signature: '0x...',
      type: 'keyAuthorization',
    })
    expect(result.success).toBe(false)
  })
})
