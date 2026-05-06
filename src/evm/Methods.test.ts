import { Methods } from 'mppx/evm'
import { describe, expect, expectTypeOf, test } from 'vp/test'

describe('charge', () => {
  test('has correct name and intent', () => {
    expect(Methods.charge.name).toBe('evm')
    expect(Methods.charge.intent).toBe('charge')
  })

  test('types: name and intent are literal', () => {
    expectTypeOf(Methods.charge.name).toEqualTypeOf<'evm'>()
    expectTypeOf(Methods.charge.intent).toEqualTypeOf<'charge'>()
  })

  test('schema: validates request and encodes method details', () => {
    const request = Methods.charge.schema.request.parse({
      amount: '1.05',
      chainId: 4326,
      credentialTypes: ['permit2'],
      currency: '0xFAfDdbb3FC7688494971a79cc65DCa3EF82079E7',
      decimals: 6,
      recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
      splits: [
        {
          amount: '0.05',
          memo: 'platform fee',
          recipient: '0x8Ba1f109551bD432803012645Ac136ddd64DBA72',
        },
      ],
    })

    expect(request.amount).toBe('1050000')
    expect(request.methodDetails).toEqual({
      chainId: 4326,
      credentialTypes: ['permit2'],
      decimals: 6,
      permit2Address: '0x000000000022D473030F116dDEE9F6B43aC78BA3',
      splits: [
        {
          amount: '50000',
          memo: 'platform fee',
          recipient: '0x8Ba1f109551bD432803012645Ac136ddd64DBA72',
        },
      ],
    })
  })

  test('schema: supports integer base-unit amount without decimals', () => {
    const request = Methods.charge.schema.request.parse({
      amount: '1000000',
      chainId: 1329,
      currency: '0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392',
      recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
    })

    expect(request.amount).toBe('1000000')
    expect(request.methodDetails?.chainId).toBe(1329)
  })

  test('schema: rejects invalid split totals', () => {
    const result = Methods.charge.schema.request.safeParse({
      amount: '1',
      chainId: 1,
      currency: '0x1111111111111111111111111111111111111111',
      decimals: 6,
      recipient: '0x2222222222222222222222222222222222222222',
      splits: [
        {
          amount: '1',
          recipient: '0x3333333333333333333333333333333333333333',
        },
      ],
    })

    expect(result.success).toBe(false)
  })

  test('schema: validates permit2 payload', () => {
    const result = Methods.charge.schema.credential.payload.safeParse({
      permit: {
        deadline: '1743523500',
        nonce: '1',
        permitted: [
          {
            amount: '1000000',
            token: '0xe15fc38f6d8c56af07bbcbe3baf5708a2bf42392',
          },
        ],
      },
      signature: '0x1234',
      transferDetails: [
        {
          requestedAmount: '1000000',
          to: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
        },
      ],
      type: 'permit2',
      witness: {
        challengeHash: '0x1a2b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890',
      },
    })

    expect(result.success).toBe(true)
  })

  test('schema: validates authorization payload', () => {
    const result = Methods.charge.schema.credential.payload.safeParse({
      from: '0x1234567890abcdef1234567890abcdef12345678',
      nonce: '0x1a2b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890',
      signature: '0x1234',
      to: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
      type: 'authorization',
      validAfter: '0',
      validBefore: '1743523500',
      value: '1000000',
    })

    expect(result.success).toBe(true)
  })

  test('schema: validates transaction and hash payloads', () => {
    expect(
      Methods.charge.schema.credential.payload.safeParse({
        signature: '0x02f8',
        type: 'transaction',
      }).success,
    ).toBe(true)
    expect(
      Methods.charge.schema.credential.payload.safeParse({
        hash: '0x1a2b3c4d5e6f7890abcdef1234567890abcdef1234567890abcdef1234567890',
        type: 'hash',
      }).success,
    ).toBe(true)
  })
})
