import { ousd, pathusd, usdc } from 'viem/tokens'
import { describe, expect, test } from 'vp/test'

import * as Currency from './Currency.js'

const pathUsd = '0x20c0000000000000000000000000000000000000'

describe('resolve', () => {
  test('resolves a chain-indexed token on any chain it lists', () => {
    expect(Currency.resolve(ousd, { chainId: 42431 })).toEqual(ousd(42431))
    expect(Currency.resolve(ousd, { chainId: 4217 })?.chainId).toBe(4217)
  })

  test('returns undefined for a chain the token does not list', () => {
    expect(Currency.resolve(pathusd, { chainId: 8453 })).toBeUndefined()
  })

  test('resolves a resolved token only on its own chain', () => {
    expect(Currency.resolve(usdc(8453), { chainId: 8453 })).toEqual(usdc(8453))
    expect(Currency.resolve(usdc(8453), { chainId: 1 })).toBeUndefined()
  })

  test('resolves an address on any chain, with the configured decimals', () => {
    expect(Currency.resolve(pathUsd, { chainId: 4217, decimals: 6 })).toEqual({
      address: pathUsd,
      chainId: 4217,
      decimals: 6,
    })
    expect(Currency.resolve(pathUsd, { chainId: 42431 })?.decimals).toBeUndefined()
  })

  test('ignores configured decimals for tokens', () => {
    expect(Currency.resolve(ousd, { chainId: 4217, decimals: 18 })?.decimals).toBe(6)
  })
})

describe('find', () => {
  test('matches addresses case-insensitively, tokens on the given chain', () => {
    const currencies = [ousd, pathUsd] as const

    expect(
      Currency.find(currencies, ousd.addresses[42431].toLowerCase(), { chainId: 42431 }),
    ).toEqual({ currency: ousd, decimals: 6 })
    expect(Currency.find(currencies, pathUsd.toUpperCase(), { decimals: 6 })).toEqual({
      currency: pathUsd,
      decimals: 6,
    })
    expect(Currency.find([usdc(8453)], usdc.addresses[1], { chainId: 1 })).toBeUndefined()
  })

  test('matches tokens on any chain they list when no chain is given', () => {
    expect(Currency.find([usdc], usdc.addresses[8453])?.currency).toBe(usdc)
    expect(Currency.find([usdc(8453)], usdc.addresses[8453])?.decimals).toBe(6)
    expect(Currency.find([usdc(8453)], usdc.addresses[1])).toBeUndefined()
  })

  test('returns undefined for a value that is not an address', () => {
    expect(Currency.find([ousd], 'usd', { chainId: 4217 })).toBeUndefined()
  })
})

describe('chainIdOf', () => {
  test('returns the chain of a resolved token only', () => {
    expect(Currency.chainIdOf(usdc(8453))).toBe(8453)
    expect(Currency.chainIdOf(usdc)).toBeUndefined()
    expect(Currency.chainIdOf(pathUsd)).toBeUndefined()
  })
})

describe('decimalsOf', () => {
  test('returns the decimals every token shares, ignoring addresses', () => {
    expect(Currency.decimalsOf([ousd, usdc(8453), pathUsd])).toBe(6)
    expect(Currency.decimalsOf([pathUsd])).toBeUndefined()
    expect(Currency.decimalsOf(undefined)).toBeUndefined()
    expect(Currency.decimalsOf([ousd, { ...usdc(8453), decimals: 18 }])).toBeUndefined()
  })
})

describe('isToken and isResolvedToken', () => {
  test('distinguish the three currency shapes', () => {
    expect([ousd, ousd(4217), pathUsd].map(Currency.isToken)).toEqual([true, false, false])
    expect([ousd, ousd(4217), pathUsd].map(Currency.isResolvedToken)).toEqual([false, true, false])
  })
})
