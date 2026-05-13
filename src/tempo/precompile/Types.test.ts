import { describe, expect, test } from 'vp/test'

import * as Types from './Types.js'

const maxUint96 = (1n << 96n) - 1n

describe('precompile Uint96', () => {
  test('accepts lower and upper bounds', () => {
    expect(Types.uint96(0n)).toBe(0n)
    expect(Types.uint96(maxUint96)).toBe(maxUint96)
    expect(Types.isUint96(0n)).toBe(true)
    expect(Types.isUint96(maxUint96)).toBe(true)
  })

  test('rejects values outside uint96 bounds', () => {
    expect(() => Types.uint96(-1n)).toThrow('outside uint96 bounds')
    expect(() => Types.uint96(maxUint96 + 1n)).toThrow('outside uint96 bounds')
    expect(Types.isUint96(-1n)).toBe(false)
    expect(Types.isUint96(maxUint96 + 1n)).toBe(false)
  })

  test('assertUint96 narrows valid values and throws for invalid values', () => {
    let amount: bigint = 1n
    Types.assertUint96(amount)
    const branded: Types.Uint96 = amount
    expect(branded).toBe(1n)
    expect(() => Types.assertUint96(maxUint96 + 1n)).toThrow('outside uint96 bounds')
  })
})
