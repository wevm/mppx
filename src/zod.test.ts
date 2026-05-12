import { describe, expect, test } from 'vp/test'

import {
  address,
  amount,
  datetime,
  datetimeInput,
  hash,
  period,
  signature,
  unwrapOptional,
  z,
} from './zod.js'

describe('amount', () => {
  test.each([
    { input: '1', expected: true, desc: 'integer' },
    { input: '1000000', expected: true, desc: 'large integer' },
    { input: '1.5', expected: true, desc: 'decimal' },
    { input: '0', expected: true, desc: 'zero' },
    { input: '007', expected: true, desc: 'leading zeros' },
    { input: '-1', expected: false, desc: 'negative number' },
    { input: '', expected: false, desc: 'empty string' },
    { input: 'abc', expected: false, desc: 'alphabetic string' },
    { input: '1.', expected: false, desc: 'trailing decimal point' },
    { input: 123 as unknown as string, expected: false, desc: 'non-string type' },
  ])('$desc ($input) → $expected', ({ input, expected }) => {
    expect(amount().safeParse(input).success).toBe(expected)
  })
})

describe('datetime', () => {
  test.each([
    { input: '2025-01-06T12:00:00Z', expected: true, desc: 'UTC with Z suffix' },
    { input: '2025-01-06T12:00:00.123Z', expected: true, desc: 'fractional seconds' },
    { input: '2025-01-06T12:00:00+05:30', expected: true, desc: 'positive UTC offset' },
    { input: '2025-01-06T12:00:00-08:00', expected: true, desc: 'negative UTC offset' },
    { input: '2025-01-06T12:00:00', expected: false, desc: 'missing timezone' },
    { input: '2025-01-06', expected: false, desc: 'date only, no time' },
    { input: '', expected: false, desc: 'empty string' },
    { input: 'not-a-date', expected: false, desc: 'non-date string' },
  ])('$desc ($input) → $expected', ({ input, expected }) => {
    expect(datetime().safeParse(input).success).toBe(expected)
  })
})

describe('datetimeInput', () => {
  test('accepts Date objects', () => {
    const result = datetimeInput().parse(new Date('2025-01-06T12:00:00Z'))

    expect(result.toISOString()).toBe('2025-01-06T12:00:00.000Z')
  })

  test('rejects invalid Date objects', () => {
    expect(datetimeInput().safeParse(new Date(Number.NaN)).success).toBe(false)
  })
})

describe('address', () => {
  test.each([
    { input: '0x1234567890abcdef1234567890abcdef12345678', expected: true, desc: 'lowercase hex' },
    { input: '0x1234567890ABCDEF1234567890ABCDEF12345678', expected: true, desc: 'uppercase hex' },
    { input: '0xAbCdEf0123456789AbCdEf0123456789AbCdEf01', expected: true, desc: 'mixed case hex' },
    { input: '0x1234', expected: false, desc: 'too short' },
    {
      input: '0x1234567890abcdef1234567890abcdef1234567890',
      expected: false,
      desc: 'too long (42 hex chars)',
    },
    {
      input: '1234567890abcdef1234567890abcdef12345678',
      expected: false,
      desc: 'missing 0x prefix',
    },
    {
      input: '0xGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGG',
      expected: false,
      desc: 'non-hex characters',
    },
    { input: '', expected: false, desc: 'empty string' },
  ])('$desc → $expected', ({ input, expected }) => {
    expect(address().safeParse(input).success).toBe(expected)
  })
})

describe('hash', () => {
  test.each([
    {
      input: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      expected: true,
      desc: 'valid 64 hex chars',
    },
    {
      input: '0xABCDEF1234567890ABCDEF1234567890ABCDEF1234567890ABCDEF1234567890',
      expected: true,
      desc: 'uppercase hex',
    },
    {
      input: '0x1234567890abcdef1234567890abcdef12345678',
      expected: false,
      desc: 'too short (address length)',
    },
    {
      input: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef00',
      expected: false,
      desc: 'too long (66 hex chars)',
    },
    {
      input: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      expected: false,
      desc: 'missing 0x prefix',
    },
    { input: '', expected: false, desc: 'empty string' },
  ])('$desc → $expected', ({ input, expected }) => {
    expect(hash().safeParse(input).success).toBe(expected)
  })
})

describe('period', () => {
  test.each([
    { input: 'day', expected: true, desc: 'day keyword' },
    { input: 'week', expected: true, desc: 'week keyword' },
    { input: 'month', expected: true, desc: 'month keyword' },
    { input: 'year', expected: true, desc: 'year keyword' },
    { input: '3600', expected: true, desc: 'numeric seconds' },
    { input: '', expected: false, desc: 'empty string' },
    { input: 'hourly', expected: false, desc: 'unsupported keyword' },
    { input: 'day1', expected: false, desc: 'keyword with trailing digits' },
  ])('$desc ($input) → $expected', ({ input, expected }) => {
    expect(period().safeParse(input).success).toBe(expected)
  })
})

describe('signature', () => {
  test.each([
    { input: '0xabcdef', expected: true, desc: 'short hex' },
    {
      input:
        '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef1b',
      expected: true,
      desc: 'full 65-byte secp256k1 signature',
    },
    { input: '0x', expected: false, desc: 'bare 0x prefix with no data' },
    { input: 'abcdef', expected: false, desc: 'missing 0x prefix' },
    { input: '0xZZZZ', expected: false, desc: 'non-hex characters after 0x' },
    { input: '', expected: false, desc: 'empty string' },
  ])('$desc → $expected', ({ input, expected }) => {
    expect(signature().safeParse(input).success).toBe(expected)
  })
})

describe('unwrapOptional', () => {
  test('unwraps optional string schema to inner type', () => {
    const inner = z.string()
    const result = unwrapOptional(z.optional(inner))
    expect(result).toBe(inner)
  })

  test('returns non-optional schema unchanged', () => {
    const schema = z.string()
    expect(unwrapOptional(schema)).toBe(schema)
  })

  test('unwraps optional number schema to inner type', () => {
    const inner = z.number()
    const result = unwrapOptional(z.optional(inner))
    expect(result).toBe(inner)
  })
})
