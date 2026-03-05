import { PaymentRequest } from 'mppx'
import { Methods } from 'mppx/tempo'
import { describe, expect, test } from 'vitest'

describe('from', () => {
  test('creates a request', () => {
    const request = PaymentRequest.from({
      amount: '1000000',
      currency: 'USD',
      recipient: '0x1234',
    })
    expect(request).toMatchInlineSnapshot(`
      {
        "amount": "1000000",
        "currency": "USD",
        "recipient": "0x1234",
      }
    `)
  })
})

describe('fromMethod', () => {
  test('creates a validated request from intent', () => {
    const request = PaymentRequest.fromMethod(Methods.charge, {
      amount: '1',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
    })
    expect(request).toMatchInlineSnapshot(`
      {
        "amount": "1000000",
        "currency": "0x20c0000000000000000000000000000000000001",
        "recipient": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
      }
    `)
  })

  test('includes methodDetails fields', () => {
    const request = PaymentRequest.fromMethod(Methods.charge, {
      amount: '1',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
      chainId: 42431,
    })
    expect(request).toMatchInlineSnapshot(`
      {
        "amount": "1000000",
        "currency": "0x20c0000000000000000000000000000000000001",
        "methodDetails": {
          "chainId": 42431,
        },
        "recipient": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
      }
    `)
  })

  test('throws on invalid request', () => {
    expect(() =>
      PaymentRequest.fromMethod(Methods.charge, {
        amount: 123,
        currency: '0x20c0000000000000000000000000000000000001',
        recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
      } as any),
    ).toThrowErrorMatchingInlineSnapshot(`
      [$ZodError: [
        {
          "expected": "string",
          "code": "invalid_type",
          "path": [
            "amount"
          ],
          "message": "Invalid input"
        },
        {
          "expected": "number",
          "code": "invalid_type",
          "path": [
            "decimals"
          ],
          "message": "Invalid input"
        }
      ]]
    `)
  })
})

describe('serialize', () => {
  test('serializes request to base64url', () => {
    const request = PaymentRequest.from({
      amount: '1000000',
      currency: 'USD',
    })
    const serialized = PaymentRequest.serialize(request)
    expect(serialized).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(serialized).not.toContain('=')
    expect(serialized).not.toContain('+')
    expect(serialized).not.toContain('/')
  })

  test('roundtrips correctly', () => {
    const original = PaymentRequest.from({
      amount: '1000000',
      currency: 'USD',
      recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
    })
    const serialized = PaymentRequest.serialize(original)
    const deserialized = PaymentRequest.deserialize(serialized)
    expect(deserialized).toMatchInlineSnapshot(`
      {
        "amount": "1000000",
        "currency": "USD",
        "recipient": "0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00",
      }
    `)
  })
})

describe('deserialize', () => {
  test('deserializes base64url to request', () => {
    const original = { amount: '500', currency: 'EUR' }
    const serialized = PaymentRequest.serialize(original)
    const result = PaymentRequest.deserialize(serialized)
    expect(result).toMatchInlineSnapshot(`
      {
        "amount": "500",
        "currency": "EUR",
      }
    `)
  })

  test('handles special characters in values', () => {
    const original = {
      amount: '1000000',
      description: 'Payment for café & más',
    }
    const serialized = PaymentRequest.serialize(original)
    const result = PaymentRequest.deserialize(serialized)
    expect(result).toMatchInlineSnapshot(`
      {
        "amount": "1000000",
        "description": "Payment for café & más",
      }
    `)
  })
})
