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
const swapTokenIn = '0x0000000000000000000000000000000000000003' as const
const swapTokenOut = '0x0000000000000000000000000000000000000004' as const
const swapData = encodeFunctionData({
  abi: Abis.stablecoinDex,
  functionName: 'swapExactAmountOut',
  args: [swapTokenIn, swapTokenOut, 100n, 100n],
})
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
    expect(() =>
      validateCalls(
        [
          {
            to: swapTokenIn,
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'approve',
              args: [Addresses.stablecoinDex, 100n],
            }),
          },
          {
            to: Addresses.stablecoinDex,
            data: swapData,
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
    expect(() =>
      validateCalls(
        [
          {
            to: swapTokenIn,
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'approve',
              args: [Addresses.stablecoinDex, 100n],
            }),
          },
          {
            to: Addresses.stablecoinDex,
            data: swapData,
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

  test('accepts approve + buy + exact expected split transfers', () => {
    expect(() =>
      validateCalls(
        [
          {
            to: swapTokenIn,
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'approve',
              args: [Addresses.stablecoinDex, 100n],
            }),
          },
          {
            to: Addresses.stablecoinDex,
            data: swapData,
          },
          {
            to: swapTokenOut,
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'transfer',
              args: [bogus, 90n],
            }),
          },
          {
            to: swapTokenOut,
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
        {
          currency: swapTokenOut,
          expectedTransfers: [
            { amount: '90', recipient: bogus },
            {
              amount: '10',
              memo: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
              recipient: '0x0000000000000000000000000000000000000002',
            },
          ],
        },
      ),
    ).not.toThrow()
  })

  test('error: rejects extra transfers when expected payments are supplied', () => {
    expect(() =>
      validateCalls(
        [
          {
            to: swapTokenOut,
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'transfer',
              args: [bogus, 100n],
            }),
          },
          {
            to: swapTokenOut,
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'transfer',
              args: ['0x0000000000000000000000000000000000000002', 1n],
            }),
          },
        ],
        details,
        {
          currency: swapTokenOut,
          expectedTransfers: [{ amount: '100', recipient: bogus }],
        },
      ),
    ).toThrow('disallowed call pattern')
  })

  test('error: rejects expected transfers to the wrong token', () => {
    expect(() =>
      validateCalls(
        [
          {
            to: swapTokenIn,
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'transfer',
              args: [bogus, 100n],
            }),
          },
        ],
        details,
        {
          currency: swapTokenOut,
          expectedTransfers: [{ amount: '100', recipient: bogus }],
        },
      ),
    ).toThrow('payment transfer does not match challenge')
  })

  test('error: rejects swaps whose output token does not fund the payment', () => {
    expect(() =>
      validateCalls(
        [
          {
            to: swapTokenIn,
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'approve',
              args: [Addresses.stablecoinDex, 100n],
            }),
          },
          {
            to: Addresses.stablecoinDex,
            data: swapData,
          },
          {
            to: bogus,
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'transfer',
              args: [bogus, 100n],
            }),
          },
        ],
        details,
        {
          currency: bogus,
          expectedTransfers: [{ amount: '100', recipient: bogus }],
        },
      ),
    ).toThrow('swap tokenOut does not match payment currency')
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
            to: swapTokenIn,
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'approve',
              args: [Addresses.stablecoinDex, 100n],
            }),
          },
          {
            to: Addresses.stablecoinDex,
            data: swapData,
          },
        ],
        details,
      ),
    ).toThrow('disallowed call pattern')
  })

  test('error: rejects approve with non-DEX spender', () => {
    expect(() =>
      validateCalls(
        [
          {
            to: swapTokenIn,
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'approve',
              args: [bogus, 100n],
            }),
          },
          {
            to: Addresses.stablecoinDex,
            data: swapData,
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

  test('behavior: rejects approve targeting a non-token contract', () => {
    expect(() =>
      validateCalls(
        [
          {
            to: bogus,
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'approve',
              args: [Addresses.stablecoinDex, 100n],
            }),
          },
          {
            to: Addresses.stablecoinDex,
            data: swapData,
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
    ).toThrow(FeePayerValidationError)
  })

  test('error: rejects buy targeting non-DEX address', () => {
    expect(() =>
      validateCalls(
        [
          {
            to: swapTokenIn,
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'approve',
              args: [Addresses.stablecoinDex, 100n],
            }),
          },
          { to: bogus, data: swapData },
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
    expect(() =>
      validateCalls(
        [
          {
            to: swapTokenIn,
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'approve',
              args: [Addresses.stablecoinDex, 100n],
            }),
          },
          {
            to: Addresses.stablecoinDex,
            data: swapData,
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

  test('accepts higher Moderato priority fees by default', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        expectedFeeToken: bogus,
        transaction: {
          ...baseTransaction,
          gas: 626_497n,
          maxFeePerGas: 24_000_000_000n,
          maxPriorityFeePerGas: 24_000_000_000n,
        } as any,
      }),
    ).not.toThrow()
  })

  test('accepts fee-payer policy overrides', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 4217,
        details,
        expectedFeeToken: bogus,
        policy: { maxPriorityFeePerGas: 50_000_000_000n },
        transaction: {
          ...baseTransaction,
          chainId: 4217,
          gas: 626_497n,
          maxFeePerGas: 24_000_000_000n,
          maxPriorityFeePerGas: 24_000_000_000n,
        } as any,
      }),
    ).not.toThrow()
  })

  test('error: rejects excessive priority fee under a custom policy override', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 4217,
        details,
        expectedFeeToken: bogus,
        policy: { maxPriorityFeePerGas: 20_000_000_000n },
        transaction: {
          ...baseTransaction,
          chainId: 4217,
          gas: 626_497n,
          maxFeePerGas: 24_000_000_000n,
          maxPriorityFeePerGas: 24_000_000_000n,
        } as any,
      }),
    ).toThrow('maxPriorityFeePerGas exceeds sponsor policy')
  })

  test('ignores undefined policy override values', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 4217,
        details,
        expectedFeeToken: bogus,
        policy: { maxPriorityFeePerGas: undefined } as any,
        transaction: {
          ...baseTransaction,
          chainId: 4217,
          gas: 626_497n,
          maxFeePerGas: 24_000_000_000n,
          maxPriorityFeePerGas: 24_000_000_000n,
        } as any,
      }),
    ).toThrow('maxPriorityFeePerGas exceeds sponsor policy')
  })

  test('preserves keyAuthorization', () => {
    const keyAuthorization = {
      address: bogus,
      chainId: 42431,
      nonce: 1n,
      r: 1n,
      s: 2n,
      yParity: 0,
    }

    const sponsored = prepareSponsoredTransaction({
      account: sponsor,
      chainId: 42431,
      details,
      expectedFeeToken: bogus,
      transaction: { ...baseTransaction, keyAuthorization } as any,
    }) as { keyAuthorization?: unknown }

    expect(sponsored.keyAuthorization).toEqual(keyAuthorization)
  })

  test('error: rejects unknown top-level fields from the sponsored transaction', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        expectedFeeToken: bogus,
        transaction: { ...baseTransaction, unexpectedField: 'ignored' } as any,
      }),
    ).toThrow('contains unsupported fields')
  })

  test('error: rejects feePayerSignature on client-submitted transactions', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        expectedFeeToken: bogus,
        transaction: {
          ...baseTransaction,
          feePayerSignature: { r: 2n, s: 3n, yParity: 1 },
        } as any,
      }),
    ).toThrow('contains rejected fields')
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
          maxFeePerGas: 50_000_000_000n,
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
