import { describe, expect, expectTypeOf, test } from 'vitest'
import { asAddress } from './asAddress.js'

describe('asAddress', () => {
  test('returns a valid address as 0x${string}', () => {
    const result = asAddress('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')
    expect(result).toBe('0x70997970C51812dc3A010C7d01b50e0d17dc79C8')
    expectTypeOf(result).toEqualTypeOf<`0x${string}`>()
  })

  test('accepts process.env-style string', () => {
    const env: string | undefined = '0x70997970C51812dc3A010C7d01b50e0d17dc79C8'
    const result = asAddress(env)
    expect(result).toBe(env)
  })

  test('throws on undefined', () => {
    expect(() => asAddress(undefined)).toThrowError('Expected an address but received undefined.')
  })

  test('throws on invalid address', () => {
    expect(() => asAddress('not-an-address')).toThrowError('Invalid address: "not-an-address".')
  })

  test('throws on empty string', () => {
    expect(() => asAddress('')).toThrowError('Invalid address')
  })
})
