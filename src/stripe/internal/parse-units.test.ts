import * as fc from 'fast-check'
import { parseUnits as parseUnitsViem } from 'viem'
import { describe, expect, test } from 'vp/test'

import { parseUnits } from './parse-units.js'

describe('parseUnits', () => {
  test.each([
    { decimals: 2, expected: 100n, value: '1' },
    { decimals: 4, expected: 12_345n, value: '1.2345' },
    { decimals: 4, expected: 12_345n, value: '1.2345000' },
    { decimals: 0, expected: 69n, value: '69.49' },
    { decimals: 0, expected: 70n, value: '69.5' },
    { decimals: 3, expected: 69_235n, value: '69.2349' },
    { decimals: 3, expected: 69_236n, value: '69.2355' },
    { decimals: 3, expected: 1_000_000_000n, value: '999999.99999' },
    { decimals: 9, expected: 1n, value: '0.00000000059' },
    { decimals: 1, expected: 14n, value: '1.4499999999999999999' },
    { decimals: 1, expected: 11n, value: '1.14999999999999999' },
    {
      decimals: 18,
      expected: 6_942_069_420_123_456_789_123_450_000n,
      value: '6942069420.12345678912345',
    },
    { decimals: 2, expected: -124n, value: '-1.235' },
    { decimals: 2, expected: 50n, value: '.5' },
    { decimals: 2, expected: 100n, value: '1.' },
  ])('converts $value with $decimals decimals', ({ decimals, expected, value }) => {
    expect(parseUnits(value, decimals)).toBe(expected)
    expect(parseUnits(value, decimals)).toBe(parseUnitsViem(value, decimals))
  })

  test('matches viem for generated decimal values', () => {
    const digits = (minimumLength: number) =>
      fc
        .array(fc.integer({ max: 9, min: 0 }), { maxLength: 100, minLength: minimumLength })
        .map((value) => value.join(''))
    const unsignedDecimal = fc.oneof(
      digits(1),
      fc.tuple(digits(1), digits(0)).map(([integer, fraction]) => `${integer}.${fraction}`),
      digits(1).map((fraction) => `.${fraction}`),
    )
    const decimal = fc
      .tuple(fc.boolean(), unsignedDecimal)
      .map(([negative, value]) => `${negative ? '-' : ''}${value}`)

    fc.assert(
      fc.property(decimal, fc.integer({ max: 50, min: 0 }), (value, decimals) => {
        expect(parseUnits(value, decimals)).toBe(parseUnitsViem(value, decimals))
      }),
      { numRuns: 2_000 },
    )
  })

  test.each(['', '.', '-', '-.', '1.2.3', '1e3', 'NaN'])('rejects invalid value %j', (value) => {
    expect(() => parseUnits(value, 2)).toThrow()
    expect(() => parseUnitsViem(value, 2)).toThrow()
  })

  test.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects invalid decimals %j',
    (decimals) => {
      expect(() => parseUnits('1', decimals)).toThrow()
      expect(() => parseUnitsViem('1', decimals)).toThrow()
    },
  )
})
