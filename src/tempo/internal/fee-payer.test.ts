import { encodeFunctionData } from 'viem'
import { Abis, Addresses } from 'viem/tempo'
import { describe, expect, test } from 'vp/test'

import {
  callScopes,
  FeePayerValidationError,
  prepareSponsoredTransaction,
  validateCalls,
} from './fee-payer.js'
import * as Selectors from './selectors.js'

const details = { amount: '1', currency: '0x01', recipient: '0x02' }
const bogus = '0x0000000000000000000000000000000000000001' as const
const sponsor = { address: bogus, type: 'local' } as any

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

  test('accepts multiple transfers after swap prefix', () => {
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
              args: [bogus, 90n],
            }),
          },
          {
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'transferWithMemo',
              args: [
                '0x0000000000000000000000000000000000000002',
                10n,
                '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
              ],
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

  test('error: rejects more than 11 transfers', () => {
    expect(() =>
      validateCalls(
        Array.from({ length: 12 }, (_, index) => ({
          data: encodeFunctionData({
            abi: Abis.tip20,
            functionName: 'transfer',
            args: [`0x${(index + 1).toString(16).padStart(40, '0')}`, 100n],
          }),
        })),
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

describe('prepareSponsoredTransaction', () => {
  const baseTransaction = {
    accessList: [],
    calls: [
      {
        data: encodeFunctionData({
          abi: Abis.tip20,
          functionName: 'transfer',
          args: [bogus, 100n],
        }),
        to: bogus,
      },
    ],
    chainId: 42431,
    feeToken: bogus,
    from: bogus,
    gas: 150_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 1_000_000_000n,
    nonce: 1n,
    nonceKey: 1n,
    signature: { r: 1n, s: 1n, yParity: 0 } as any,
    validBefore: Math.floor(Date.now() / 1_000) + 300,
  } as const

  test('accepts bounded sponsored transaction fields', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        expectedFeeToken: bogus,
        transaction: baseTransaction as any,
      }),
    ).not.toThrow()
  })

  test('drops unknown top-level fields from the sponsored transaction', () => {
    const sponsored = prepareSponsoredTransaction({
      account: sponsor,
      chainId: 42431,
      details,
      expectedFeeToken: bogus,
      transaction: { ...baseTransaction, unexpectedField: 'ignored' } as any,
    }) as Record<string, unknown>

    expect(sponsored.unexpectedField).toBeUndefined()
  })

  test('error: rejects excessive maxFeePerGas', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        expectedFeeToken: bogus,
        transaction: {
          ...baseTransaction,
          maxFeePerGas: 200_000_000_000n,
        } as any,
      }),
    ).toThrow('maxFeePerGas exceeds sponsor policy')
  })

  test('error: rejects combined gas and fee budget outside policy', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        expectedFeeToken: bogus,
        transaction: {
          ...baseTransaction,
          gas: 1_500_000n,
          maxFeePerGas: 10_000_000_000n,
        } as any,
      }),
    ).toThrow('total fee budget exceeds sponsor policy')
  })

  test('error: rejects mismatched feeToken', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        expectedFeeToken: '0x0000000000000000000000000000000000000002',
        transaction: baseTransaction as any,
      }),
    ).toThrow('feeToken is not allowed')
  })

  test('error: rejects long-lived sponsored transactions', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        expectedFeeToken: bogus,
        transaction: {
          ...baseTransaction,
          validBefore: Math.floor(Date.now() / 1_000) + 3_600,
        } as any,
      }),
    ).toThrow('validity window exceeds sponsor policy')
  })
})
