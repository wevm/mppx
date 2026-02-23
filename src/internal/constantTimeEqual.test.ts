import { describe, expect, test } from 'vitest'
import { constantTimeEqual } from './constantTimeEqual.js'

describe('constantTimeEqual', () => {
  test('returns true for identical strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
  })

  test('returns true for empty strings', () => {
    expect(constantTimeEqual('', '')).toBe(true)
  })

  test('returns false for different strings of same length', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
  })

  test('returns false for different lengths', () => {
    expect(constantTimeEqual('abc', 'abcd')).toBe(false)
    expect(constantTimeEqual('abcd', 'abc')).toBe(false)
  })

  test('returns false for empty vs non-empty', () => {
    expect(constantTimeEqual('', 'a')).toBe(false)
    expect(constantTimeEqual('a', '')).toBe(false)
  })

  test('returns false when only first character differs', () => {
    expect(constantTimeEqual('xbc', 'abc')).toBe(false)
  })

  test('returns false when only last character differs', () => {
    expect(constantTimeEqual('abx', 'abc')).toBe(false)
  })

  test('handles base64url strings (typical HMAC output)', () => {
    const a = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const b = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    expect(constantTimeEqual(a, b)).toBe(true)
  })

  test('detects single-bit difference in base64url strings', () => {
    const a = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk'
    const b = 'dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXl'
    expect(constantTimeEqual(a, b)).toBe(false)
  })
})
