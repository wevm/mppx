import { Methods } from 'mppx/tempo'
import { describe, expect, expectTypeOf, test } from 'vp/test'

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

  test('schema: validates valid request', () => {
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

  test('schema: validates request with splits', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      splits: [
        {
          amount: '0.25',
          recipient: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        },
        {
          amount: '0.1',
          memo: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
          recipient: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      ],
    })
    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.data.methodDetails?.splits).toEqual([
      {
        amount: '250000',
        recipient: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
      },
      {
        amount: '100000',
        memo: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
        recipient: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      },
    ])
  })

  test('schema: rejects empty splits', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      splits: [],
    })
    expect(result.success).toBe(false)
  })

  test('schema: rejects more than 10 splits', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '11',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      splits: Array.from({ length: 11 }, (_, index) => ({
        amount: '0.1',
        recipient: `0x${(index + 1).toString(16).padStart(40, '0')}`,
      })),
    })
    expect(result.success).toBe(false)
  })

  test('schema: rejects split totals greater than or equal to amount', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      splits: [
        {
          amount: '0.5',
          recipient: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        },
        {
          amount: '0.5',
          recipient: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  test('schema: rejects zero-amount with splits', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '0',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      splits: [
        {
          amount: '0.1',
          recipient: '0xabcdefabcdefabcdefabcdefabcdefabcdefabcd',
        },
      ],
    })
    expect(result.success).toBe(false)
  })

  test('schema: accepts zero-amount without splits', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '0',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
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
})

describe('session', () => {
  test('has correct name and intent', () => {
    expect(Methods.session.intent).toBe('session')
    expect(Methods.session.name).toBe('tempo')
  })

  test('schema: encodes minVoucherDelta in base units', () => {
    const request = Methods.session.schema.request.parse({
      amount: '1',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      escrowContract: '0x1234567890abcdef1234567890abcdef12345678',
      minVoucherDelta: '0.1',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      unitType: 'token',
    })

    expect(request.amount).toBe('1000000')
    expect(request.methodDetails?.minVoucherDelta).toBe('100000')
  })
})
