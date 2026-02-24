import { Currency, Methods } from 'mppx/tempo'
import { describe, expect, expectTypeOf, test } from 'vitest'

describe('Currency', () => {
  test('isTokenAddress: valid 0x + 40 hex addresses', () => {
    expect(Currency.isTokenAddress('0x20c0000000000000000000000000000000000000')).toBe(true)
    expect(Currency.isTokenAddress('usd')).toBe(false)
    expect(Currency.isTokenAddress('USD')).toBe(false)
    expect(Currency.isTokenAddress('')).toBe(false)
    expect(Currency.isTokenAddress('0x')).toBe(false)
    expect(Currency.isTokenAddress('0x123')).toBe(false)
    expect(Currency.isTokenAddress('0xZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(false)
  })

  test('isCurrencyCode: supported codes', () => {
    expect(Currency.isCurrencyCode('usd')).toBe(true)
    expect(Currency.isCurrencyCode('USD')).toBe(false)
    expect(Currency.isCurrencyCode('eur')).toBe(false)
    expect(Currency.isCurrencyCode('0x20c0')).toBe(false)
  })

  test('supported: only usd', () => {
    expect(Currency.supported).toEqual(['usd'])
  })
})

describe('charge', () => {
  test('has correct name and intent', () => {
    expect(Methods.charge.intent).toBe('charge')
    expect(Methods.charge.name).toBe('tempo')
  })

  test('types: intent is literal', () => {
    expectTypeOf(Methods.charge.intent).toEqualTypeOf<'charge'>()
  })

  test('types: name is literal', () => {
    expectTypeOf(Methods.charge.name).toEqualTypeOf<'tempo'>()
  })

  test('schema: validates valid request (legacy token address)', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates request with methodDetails', () => {
    const result = Methods.charge.schema.request.safeParse({
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
    const result = Methods.charge.schema.request.safeParse({
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
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
    })
    expect(result.success).toBe(false)
  })

  test('schema: validates transaction payload', () => {
    const result = Methods.charge.schema.credential.payload.safeParse({
      signature: '0x76f90100000000000000000000000000000000000000000000000000000000000000000000',
      type: 'transaction',
    })
    expect(result.success).toBe(true)
  })

  test('schema: validates hash payload', () => {
    const result = Methods.charge.schema.credential.payload.safeParse({
      hash: '0x1a2b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890',
      type: 'hash',
    })
    expect(result.success).toBe(true)
  })

  test('schema: rejects invalid payload type', () => {
    const result = Methods.charge.schema.credential.payload.safeParse({
      signature: '0x...',
      type: 'keyAuthorization',
    })
    expect(result.success).toBe(false)
  })

  // ---------------------------------------------------------------------------
  // Base currency settlement schema validation
  // ---------------------------------------------------------------------------

  test('schema: validates base currency with settlementCurrencies', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: 'usd',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      settlementCurrencies: [
        '0x20c0000000000000000000000000000000000000',
        '0xABC0000000000000000000000000000000000000',
      ],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.currency).toBe('usd')
      expect(result.data.settlementCurrencies).toEqual([
        '0x20c0000000000000000000000000000000000000',
        '0xABC0000000000000000000000000000000000000',
      ])
    }
  })

  test('schema: rejects token address with settlementCurrencies', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      settlementCurrencies: ['0x20c0000000000000000000000000000000000000'],
    })
    expect(result.success).toBe(false)
  })

  test('schema: rejects base currency without settlementCurrencies', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: 'usd',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
    })
    expect(result.success).toBe(false)
  })

  test('schema: rejects base currency with empty settlementCurrencies', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: 'usd',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      settlementCurrencies: [],
    })
    expect(result.success).toBe(false)
  })

  test('schema: settlementCurrencies passes through to output', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: 'usd',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      settlementCurrencies: ['0x20c0000000000000000000000000000000000000'],
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.settlementCurrencies).toEqual([
        '0x20c0000000000000000000000000000000000000',
      ])
    }
  })

  test('schema: rejects unsupported currency code', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: 'eur',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      settlementCurrencies: ['0x20c0000000000000000000000000000000000000'],
    })
    expect(result.success).toBe(false)
  })

  test('schema: rejects invalid currency (not address or code)', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: 'blahblah',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      settlementCurrencies: ['0x20c0000000000000000000000000000000000000'],
    })
    expect(result.success).toBe(false)
  })

  test('schema: rejects short 0x prefix as currency', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: '0x',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
    })
    expect(result.success).toBe(false)
  })

  test('schema: rejects invalid addresses in settlementCurrencies', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: 'usd',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      settlementCurrencies: ['not-an-address'],
    })
    expect(result.success).toBe(false)
  })

  test('schema: legacy request without settlementCurrencies omits field', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.settlementCurrencies).toBeUndefined()
    }
  })

  // ---------------------------------------------------------------------------
  // Schema transform behavior
  // ---------------------------------------------------------------------------

  test('schema: transform converts amount with parseUnits', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1.5',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.amount).toBe('1500000')
    }
  })

  test('schema: transform omits methodDetails when not needed', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.methodDetails).toBeUndefined()
    }
  })

  test('schema: transform includes methodDetails when memo provided', () => {
    const memo = '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef'
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      memo,
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.methodDetails).toBeDefined()
      expect(result.data.methodDetails?.memo).toBe(memo)
    }
  })

  test('schema: transform converts feePayer Account to boolean', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      feePayer: { address: '0x0000000000000000000000000000000000000001' },
    })
    expect(result.success).toBe(true)
    if (result.success) {
      expect(result.data.methodDetails?.feePayer).toBe(true)
    }
  })

  test('schema: token address with empty settlementCurrencies rejected', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      expires: '2025-02-05T12:05:00Z',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      settlementCurrencies: [],
    })
    expect(result.success).toBe(false)
  })
})
