import { describe, expect, test } from 'vitest'
import * as Intent from './Intent.js'

describe('charge', () => {
  test('behavior: validates valid request', () => {
    const result = Intent.charge.schema.request.parse({
      amount: '1000',
      currency: 'USD',
    })
    expect(result.amount).toBe('1000')
    expect(result.currency).toBe('USD')
    expect(result.expires).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/)
  })

  test('behavior: validates with all optional fields', () => {
    expect(
      Intent.charge.schema.request.parse({
        amount: '1000',
        currency: 'USD',
        description: 'Test payment',
        expires: '2030-01-01T00:00:00Z',
        externalId: 'order-123',
        recipient: '0x1234567890abcdef',
      }),
    ).toMatchInlineSnapshot(`
      {
        "amount": "1000",
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
          "pattern": "/^\\\\d+$/",
          "path": [
            "amount"
          ],
          "message": "Invalid amount"
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
          "origin": "string",
          "code": "invalid_format",
          "format": "regex",
          "pattern": "/^\\\\d+$/",
          "path": [
            "amount"
          ],
          "message": "Invalid amount"
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
