import { encodeFunctionData } from 'viem'
import { Abis, Addresses } from 'viem/tempo'
import { describe, expect, test } from 'vitest'
import { callScopes, FeePayerValidationError, validateCalls } from './fee-payer.js'
import * as Selectors from './selectors.js'

const details = { amount: '1', currency: '0x01', recipient: '0x02' }
const bogus = '0x0000000000000000000000000000000000000001' as const

describe('callScopes', () => {
  test('has 4 allowed patterns', () => {
    expect(callScopes).toHaveLength(4)
  })

  test('patterns use correct selectors', () => {
    expect(callScopes).toEqual([
      [Selectors.transfer],
      [Selectors.transferWithMemo],
      [Selectors.approve, Selectors.swapExactAmountOut, Selectors.transfer],
      [Selectors.approve, Selectors.swapExactAmountOut, Selectors.transferWithMemo],
    ])
  })
})

describe('validateCalls', () => {
  test('accepts single transfer', () => {
    expect(() =>
      validateCalls(
        [
          {
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'transfer',
              args: [bogus, 100n],
            }),
          },
        ],
        details,
      ),
    ).not.toThrow()
  })

  test('accepts approve + buy + transfer', () => {
    const swapSelector = Selectors.swapExactAmountOut
    expect(() =>
      validateCalls(
        [
          {
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'approve',
              args: [Addresses.stablecoinDex, 100n],
            }),
          },
          {
            to: Addresses.stablecoinDex,
            data: `${swapSelector}${'00'.repeat(128)}` as `0x${string}`,
          },
          {
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'transfer',
              args: [bogus, 100n],
            }),
          },
        ],
        details,
      ),
    ).not.toThrow()
  })

  test('error: rejects empty calls', () => {
    expect(() => validateCalls([], details)).toThrow(FeePayerValidationError)
  })

  test('error: rejects unknown selector', () => {
    expect(() => validateCalls([{ data: '0xdeadbeef' as `0x${string}` }], details)).toThrow(
      'disallowed call pattern',
    )
  })

  test('error: rejects extra calls beyond allowed patterns', () => {
    const swapSelector = Selectors.swapExactAmountOut
    expect(() =>
      validateCalls(
        [
          {
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'approve',
              args: [Addresses.stablecoinDex, 100n],
            }),
          },
          {
            to: Addresses.stablecoinDex,
            data: `${swapSelector}${'00'.repeat(128)}` as `0x${string}`,
          },
          {
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'transfer',
              args: [bogus, 100n],
            }),
          },
          {
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'transfer',
              args: [bogus, 100n],
            }),
          },
        ],
        details,
      ),
    ).toThrow('disallowed call pattern')
  })

  test('error: rejects wrong order (transfer before approve + buy)', () => {
    const swapSelector = Selectors.swapExactAmountOut
    expect(() =>
      validateCalls(
        [
          {
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'transfer',
              args: [bogus, 100n],
            }),
          },
          {
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'approve',
              args: [Addresses.stablecoinDex, 100n],
            }),
          },
          {
            to: Addresses.stablecoinDex,
            data: `${swapSelector}${'00'.repeat(128)}` as `0x${string}`,
          },
        ],
        details,
      ),
    ).toThrow('disallowed call pattern')
  })

  test('error: rejects approve with non-DEX spender', () => {
    const swapSelector = Selectors.swapExactAmountOut
    expect(() =>
      validateCalls(
        [
          {
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'approve',
              args: [bogus, 100n],
            }),
          },
          {
            to: Addresses.stablecoinDex,
            data: `${swapSelector}${'00'.repeat(128)}` as `0x${string}`,
          },
          {
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'transfer',
              args: [bogus, 100n],
            }),
          },
        ],
        details,
      ),
    ).toThrow('approve spender is not the DEX')
  })

  test('error: rejects buy targeting non-DEX address', () => {
    const swapSelector = Selectors.swapExactAmountOut
    expect(() =>
      validateCalls(
        [
          {
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'approve',
              args: [Addresses.stablecoinDex, 100n],
            }),
          },
          { to: bogus, data: `${swapSelector}${'00'.repeat(128)}` as `0x${string}` },
          {
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'transfer',
              args: [bogus, 100n],
            }),
          },
        ],
        details,
      ),
    ).toThrow('buy target is not the DEX')
  })

  test('error: rejects approve + buy without transfer', () => {
    const swapSelector = Selectors.swapExactAmountOut
    expect(() =>
      validateCalls(
        [
          {
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'approve',
              args: [Addresses.stablecoinDex, 100n],
            }),
          },
          {
            to: Addresses.stablecoinDex,
            data: `${swapSelector}${'00'.repeat(128)}` as `0x${string}`,
          },
        ],
        details,
      ),
    ).toThrow('disallowed call pattern')
  })
})
