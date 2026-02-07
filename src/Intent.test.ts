import { describe, expect, test } from 'vitest'
import * as Intent from './Intent.js'

describe('charge', () => {
  test('behavior: validates valid request', () => {
    const result = Intent.charge.schema.request.parse({
      amount: '1000',
      currency: 'USD',
      decimals: 6,
    })
    expect(result.amount).toBe('1000000000')
    expect(result.currency).toBe('USD')
    expect(result.expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  test('behavior: validates with all optional fields', () => {
    expect(
      Intent.charge.schema.request.parse({
        amount: '1000',
        currency: 'USD',
        decimals: 6,
        description: 'Test payment',
        expires: '2030-01-01T00:00:00Z',
        externalId: 'order-123',
        recipient: '0x1234567890abcdef',
      }),
    ).toMatchInlineSnapshot(`
      {
        "amount": "1000000000",
        "currency": "USD",
        "description": "Test payment",
        "expires": "2030-01-01T00:00:00Z",
        "externalId": "order-123",
        "recipient": "0x1234567890abcdef",
      }
    `)
  })

  test('error: invalid amount (non-numeric)', () => {
    expect(() =>
      Intent.charge.schema.request.parse({
        amount: 'abc',
        currency: 'USD',
      }),
    ).toThrowErrorMatchingInlineSnapshot(`
      [$ZodError: [
        {
          "origin": "string",
          "code": "invalid_format",
          "format": "regex",
          "pattern": "/^\\\\d+(\\\\.\\\\d+)?$/",
          "path": [
            "amount"
          ],
          "message": "Invalid amount"
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

  test('error: invalid amount (decimal)', () => {
    expect(() =>
      Intent.charge.schema.request.parse({
        amount: '100.50',
        currency: 'USD',
      }),
    ).toThrowErrorMatchingInlineSnapshot(`
      [$ZodError: [
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

  test('error: invalid expires (not ISO 8601)', () => {
    expect(() =>
      Intent.charge.schema.request.parse({
        amount: '1000',
        currency: 'USD',
        expires: 'not-a-date',
      }),
    ).toThrowErrorMatchingInlineSnapshot(`
      [$ZodError: [
        {
          "expected": "number",
          "code": "invalid_type",
          "path": [
            "decimals"
          ],
          "message": "Invalid input"
        },
        {
          "origin": "string",
          "code": "invalid_format",
          "format": "regex",
          "pattern": "/^\\\\d{4}-\\\\d{2}-\\\\d{2}T\\\\d{2}:\\\\d{2}:\\\\d{2}(?:\\\\.\\\\d+)?(?:Z|[+-]\\\\d{2}:\\\\d{2})$/",
          "path": [
            "expires"
          ],
          "message": "Invalid ISO 8601 datetime"
        }
      ]]
    `)
  })
})

describe('stream', () => {
  test('behavior: converts amount to base units', () => {
    const result = Intent.stream.schema.request.parse({
      amount: '0.000025',
      unitType: 'llm_token',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
    })
    expect(result.amount).toBe('25')
    expect(result.unitType).toBe('llm_token')
    expect(result.currency).toBe('0x20c0000000000000000000000000000000000001')
    expect(result).not.toHaveProperty('decimals')
  })

  test('behavior: converts suggestedDeposit to base units', () => {
    const result = Intent.stream.schema.request.parse({
      amount: '0.000025',
      unitType: 'llm_token',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      suggestedDeposit: '10',
    })
    expect(result.amount).toBe('25')
    expect(result.suggestedDeposit).toBe('10000000')
  })

  test('behavior: works without suggestedDeposit', () => {
    const result = Intent.stream.schema.request.parse({
      amount: '1',
      unitType: 'request',
      currency: '0x20c0000000000000000000000000000000000001',
      decimals: 6,
    })
    expect(result.amount).toBe('1000000')
    expect(result).not.toHaveProperty('suggestedDeposit')
  })

  test('error: rejects missing decimals', () => {
    expect(() =>
      Intent.stream.schema.request.parse({
        amount: '25',
        unitType: 'llm_token',
        currency: '0x20c0000000000000000000000000000000000001',
      }),
    ).toThrow()
  })

  test('error: rejects invalid amount', () => {
    expect(() =>
      Intent.stream.schema.request.parse({
        amount: 'abc',
        unitType: 'llm_token',
        currency: '0x20c0000000000000000000000000000000000001',
        decimals: 6,
      }),
    ).toThrow()
  })
})
