import type { Address } from 'viem'
import { describe, expect, test } from 'vp/test'

import { defaultCurrencies, InsufficientFundsError, resolve } from './auto-swap.js'

describe('defaultCurrencies', () => {
  test('default', () => {
    expect(defaultCurrencies).toMatchInlineSnapshot(`
      [
        "0x20c0000000000000000000000000000000000000",
        "0x20C000000000000000000000b9537d11c60E8b50",
      ]
    `)
  })
})

describe('resolve', () => {
  const defaults = defaultCurrencies

  test('returns false for undefined', () => {
    expect(resolve(undefined, defaults)).toMatchInlineSnapshot(`false`)
  })

  test('returns false for false', () => {
    expect(resolve(false, defaults)).toMatchInlineSnapshot(`false`)
  })

  test('true resolves to defaults with 1% slippage', () => {
    expect(resolve(true, defaults)).toMatchInlineSnapshot(`
      {
        "slippage": 1,
        "tokenIn": [
          "0x20c0000000000000000000000000000000000000",
          "0x20C000000000000000000000b9537d11c60E8b50",
        ],
      }
    `)
  })

  test('empty options resolves to defaults with 1% slippage', () => {
    expect(resolve({}, defaults)).toMatchInlineSnapshot(`
      {
        "slippage": 1,
        "tokenIn": [
          "0x20c0000000000000000000000000000000000000",
          "0x20C000000000000000000000b9537d11c60E8b50",
        ],
      }
    `)
  })

  test('custom slippage', () => {
    expect(resolve({ slippage: 5 }, defaults)).toMatchInlineSnapshot(`
      {
        "slippage": 5,
        "tokenIn": [
          "0x20c0000000000000000000000000000000000000",
          "0x20C000000000000000000000b9537d11c60E8b50",
        ],
      }
    `)
  })

  test('custom tokenIn prepends to defaults', () => {
    const custom = '0x0000000000000000000000000000000000000099' as Address
    expect(resolve({ tokenIn: [custom] }, defaults)).toMatchInlineSnapshot(`
      {
        "slippage": 1,
        "tokenIn": [
          "0x0000000000000000000000000000000000000099",
          "0x20c0000000000000000000000000000000000000",
          "0x20C000000000000000000000b9537d11c60E8b50",
        ],
      }
    `)
  })

  test('custom tokenIn deduplicates against defaults', () => {
    expect(resolve({ tokenIn: [defaults[0]!] }, defaults)).toMatchInlineSnapshot(`
      {
        "slippage": 1,
        "tokenIn": [
          "0x20c0000000000000000000000000000000000000",
          "0x20C000000000000000000000b9537d11c60E8b50",
        ],
      }
    `)
  })

  test('custom tokenIn + custom slippage', () => {
    const custom = '0x0000000000000000000000000000000000000099' as Address
    expect(resolve({ tokenIn: [custom], slippage: 3 }, defaults)).toMatchInlineSnapshot(`
      {
        "slippage": 3,
        "tokenIn": [
          "0x0000000000000000000000000000000000000099",
          "0x20c0000000000000000000000000000000000000",
          "0x20C000000000000000000000b9537d11c60E8b50",
        ],
      }
    `)
  })
})

describe('InsufficientFundsError', () => {
  test('default', () => {
    const error = new InsufficientFundsError({
      currency: '0x0000000000000000000000000000000000000001',
    })
    expect(error).toMatchInlineSnapshot(
      `[InsufficientFundsError: Insufficient funds: no balance in 0x0000000000000000000000000000000000000001 and no viable swap route from fallback currencies.]`,
    )
  })
})
