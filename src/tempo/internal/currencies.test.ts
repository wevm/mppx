import { defineToken, ousd, tokens as tokenSets } from 'viem/tokens'
import { describe, expect, test } from 'vp/test'

import { resolve } from './currencies.js'
import { tokens } from './defaults.js'

describe('resolve', () => {
  test.each([
    { parameters: {}, expected: [tokens.ousd, tokens.usdc], chain: 4217 },
    { parameters: { testnet: true }, expected: [tokens.pathUsd], chain: 42431 },
    { parameters: { chainId: 42431 }, expected: [tokens.pathUsd], chain: 42431 },
    {
      parameters: { chainId: 4217, testnet: true },
      expected: [tokens.ousd, tokens.usdc],
      chain: 4217,
    },
    { parameters: { chainId: 31337 }, expected: [tokens.pathUsd], chain: 31337 },
    {
      parameters: { currencies: [tokens.usdc, tokens.ousd] },
      expected: [tokens.usdc, tokens.ousd],
      chain: 4217,
    },
    { parameters: { currencies: [ousd] }, expected: [tokens.ousd], chain: 4217 },
  ])('resolves $parameters', ({ parameters, expected, chain }) => {
    expect(resolve(parameters)).toEqual(
      expected.map((currency) => ({ currency, decimals: 6, chainId: chain })),
    )
  })

  test('deduplicates addresses across strings and definitions, preserving first occurrence', () => {
    expect(
      resolve({
        currencies: [tokens.usdc, ousd, tokens.ousd.toLowerCase(), tokens.usdc.toLowerCase()],
      }),
    ).toEqual(resolve({ currencies: [tokens.usdc, tokens.ousd] }))
  })

  test('resolves maintained viem sets by chain and denomination', () => {
    const expected = tokenSets.tempo.filter(
      (token) => token.currency === 'USD' && 4217 in token.addresses,
    )
    expect(resolve({ currencies: tokenSets.tempo })).toEqual(
      expected.map((token) => ({
        currency: (token.addresses as Record<number, string>)[4217],
        decimals: token.decimals,
        chainId: 4217,
      })),
    )
  })

  test('skips unsupported chains and non-USD or missing denominations', () => {
    expect(
      resolve({
        currencies: [
          defineToken({ addresses: { 1: tokens.usdc }, currency: 'USD', decimals: 6 }),
          defineToken({ addresses: { 4217: tokens.usdc }, currency: 'EUR', decimals: 6 }),
          defineToken({ addresses: { 4217: tokens.usdc }, decimals: 6 }),
          ousd,
        ],
      }),
    ).toEqual(resolve({ currencies: [ousd] }))
  })

  test('uses token metadata decimals and explicit address decimals', () => {
    expect(resolve({ currencies: [tokens.ousd], decimals: 8 })[0].decimals).toBe(8)
    expect(
      resolve({
        currencies: [
          defineToken({ addresses: { 4217: tokens.ousd }, currency: 'USD', decimals: 8 }),
        ],
      })[0].decimals,
    ).toBe(8)
    expect(resolve({ currencies: [ousd], decimals: 6 })[0].decimals).toBe(6)
  })

  test.each([
    { parameters: { currencies: [] }, message: 'No accepted USD currencies' },
    {
      parameters: { currencies: [ousd], testnet: true },
      message: 'No accepted USD currencies for chain 42431',
    },
    { parameters: { currencies: ['invalid'] }, message: 'Invalid Tempo currency address' },
    {
      parameters: { currencies: [ousd], decimals: 18 },
      message: 'must match each token definition',
    },
    ...[-1, 1.5, 256, NaN].map((decimals) => ({
      parameters: { currencies: [tokens.ousd], decimals },
      message: 'Token decimals must be an integer',
    })),
  ])('rejects $parameters', ({ parameters, message }) => {
    expect(() => resolve(parameters)).toThrow(message)
  })
})
