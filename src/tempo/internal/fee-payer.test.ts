import { Address, Secp256k1 } from 'ox'
import { TxEnvelopeTempo } from 'ox/tempo'
import { encodeFunctionData, maxUint256, toHex } from 'viem'
import { Abis, Addresses, Transaction } from 'viem/tempo'
import { afterEach, describe, expect, test, vi } from 'vp/test'

import * as defaults from './defaults.js'
import {
  assertAllowedFeeToken,
  callScopes,
  defaultAllowedFeeTokens,
  FeePayerValidationError,
  fillHostedFeePayerTransaction,
  prepareSponsoredTransaction,
  simulationTransaction,
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
const feePayerSignature = {
  r: '0x0000000000000000000000000000000000000000000000000000000000000002',
  s: '0x0000000000000000000000000000000000000000000000000000000000000003',
  yParity: 1,
}
const sponsor = { address: bogus, type: 'local' } as any

afterEach(() => {
  vi.unstubAllGlobals()
})

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

describe('fee token allowlist', () => {
  test('includes pathUSD and the chain default currency', () => {
    expect(defaultAllowedFeeTokens(defaults.chainId.mainnet)).toEqual([
      defaults.tokens.pathUsd,
      defaults.tokens.usdc,
    ])
  })

  test('dedupes when pathUSD is the chain default currency', () => {
    expect(defaultAllowedFeeTokens(defaults.chainId.testnet)).toEqual([defaults.tokens.pathUsd])
  })

  test('accepts allowlisted fee tokens', () => {
    expect(() =>
      assertAllowedFeeToken(
        { feeToken: defaults.tokens.usdc },
        defaultAllowedFeeTokens(defaults.chainId.mainnet),
      ),
    ).not.toThrow()
  })

  test('error: rejects non-string fee tokens', () => {
    expect(() =>
      assertAllowedFeeToken({ feeToken: 1n }, defaultAllowedFeeTokens(defaults.chainId.mainnet)),
    ).toThrow('feeToken is invalid')
  })

  test('error: rejects fee tokens outside the allowlist', () => {
    expect(() =>
      assertAllowedFeeToken(
        { feeToken: swapTokenIn },
        defaultAllowedFeeTokens(defaults.chainId.mainnet),
      ),
    ).toThrow('feeToken is not allowed')
  })
})

describe('fillHostedFeePayerTransaction', () => {
  const hostedTransaction = {
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
    chainId: defaults.chainId.mainnet,
    from: bogus,
    gas: 150_000n,
    maxFeePerGas: 1_000_000_000n,
    maxPriorityFeePerGas: 0n,
    nonce: 1n,
    nonceKey: maxUint256,
    signature: { r: 1n, s: 1n, yParity: 0 } as any,
    validBefore: Math.floor(Date.now() / 1_000) + 300,
  } as const

  test('uses hosted fillTransaction and preserves sender-committed fields', async () => {
    // Sign over the payload built from the actual RPC request body so this
    // verifies recovery parity with the real request shape.
    const sponsorPrivateKey =
      '0x0000000000000000000000000000000000000000000000000000000000000042' as const
    const sponsorAddress = Address.fromPublicKey(
      Secp256k1.getPublicKey({ privateKey: sponsorPrivateKey }),
    )
    let realFeePayerSignature: ReturnType<typeof Secp256k1.sign> | undefined

    const calls: { init?: RequestInit | undefined; input: RequestInfo | URL }[] = []
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ init, input })
      const rpc = JSON.parse(init!.body as string).params[0]
      const quantity = (value: unknown) =>
        value === undefined ? undefined : BigInt(value as string)
      realFeePayerSignature = Secp256k1.sign({
        payload: TxEnvelopeTempo.getFeePayerSignPayload(
          TxEnvelopeTempo.from({
            accessList: rpc.accessList,
            calls: rpc.calls.map(({ value, ...call }: any) => ({
              ...call,
              ...(value && value !== '0x' ? { value: BigInt(value) } : {}),
            })),
            chainId: hostedTransaction.chainId,
            feeToken: defaults.tokens.pathUsd,
            from: rpc.from,
            ...(quantity(rpc.gas) !== undefined ? { gas: quantity(rpc.gas) } : {}),
            ...(rpc.keyAuthorization !== undefined
              ? { keyAuthorization: rpc.keyAuthorization }
              : {}),
            ...(quantity(rpc.maxFeePerGas) !== undefined
              ? { maxFeePerGas: quantity(rpc.maxFeePerGas) }
              : {}),
            ...(quantity(rpc.maxPriorityFeePerGas) !== undefined
              ? { maxPriorityFeePerGas: quantity(rpc.maxPriorityFeePerGas) }
              : {}),
            ...(quantity(rpc.nonce) !== undefined ? { nonce: quantity(rpc.nonce) } : {}),
            ...(quantity(rpc.nonceKey) !== undefined ? { nonceKey: quantity(rpc.nonceKey) } : {}),
            type: 'tempo',
            ...(rpc.validAfter !== undefined ? { validAfter: Number(BigInt(rpc.validAfter)) } : {}),
            ...(rpc.validBefore !== undefined
              ? { validBefore: Number(BigInt(rpc.validBefore)) }
              : {}),
          } as any) as any,
          { sender: rpc.from },
        ),
        privateKey: sponsorPrivateKey,
      })
      return new Response(
        JSON.stringify(
          {
            result: {
              tx: {
                feePayerSignature: realFeePayerSignature,
                feeToken: defaults.tokens.pathUsd,
                gas: '0x1',
                maxFeePerGas: '0x2',
              },
            },
          },
          (_key, value) => (typeof value === 'bigint' ? toHex(value) : value),
        ),
      )
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await fillHostedFeePayerTransaction({
      allowedFeeTokens: defaultAllowedFeeTokens(defaults.chainId.mainnet),
      transaction: hostedTransaction as any,
      url: 'https://sponsor.example/tp_key',
    })

    expect(result.feeToken).toBe(defaults.tokens.pathUsd)
    expect(result.feePayer.toLowerCase()).toBe(sponsorAddress.toLowerCase())
    const serialized = result.serializedTransaction

    expect(fetchMock).toHaveBeenCalledOnce()
    expect(calls[0]!.input).toBe('https://sponsor.example/tp_key')
    const body = JSON.parse(calls[0]!.init!.body as string)
    expect(body).toMatchObject({
      jsonrpc: '2.0',
      method: 'eth_fillTransaction',
    })
    expect(body.params[0]).toMatchObject({
      calls: hostedTransaction.calls.map((call) => ({
        data: call.data,
        to: call.to,
        value: '0x',
      })),
      feePayer: true,
      from: hostedTransaction.from,
      gas: toHex(hostedTransaction.gas),
      maxFeePerGas: toHex(hostedTransaction.maxFeePerGas),
      maxPriorityFeePerGas: toHex(hostedTransaction.maxPriorityFeePerGas),
      nonce: toHex(hostedTransaction.nonce),
      nonceKey: toHex(hostedTransaction.nonceKey),
      type: '0x76',
      validBefore: toHex(hostedTransaction.validBefore),
    })

    const transaction: Transaction.TransactionSerializableTempo = Transaction.deserialize(
      serialized as Transaction.TransactionSerializedTempo,
    )
    expect(transaction.gas).toBe(hostedTransaction.gas)
    expect(transaction.maxFeePerGas).toBe(hostedTransaction.maxFeePerGas)
    expect(transaction.calls).toEqual(hostedTransaction.calls)
    expect(transaction.feeToken).toBe(defaults.tokens.pathUsd)
    expect(BigInt(transaction.feePayerSignature!.r)).toBe(realFeePayerSignature!.r)
    expect(BigInt(transaction.feePayerSignature!.s)).toBe(realFeePayerSignature!.s)
  })

  test('error: requires hosted fee payer to return a feeToken', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ result: { tx: { feePayerSignature } } }))),
    )

    await expect(
      fillHostedFeePayerTransaction({
        allowedFeeTokens: defaultAllowedFeeTokens(defaults.chainId.mainnet),
        transaction: hostedTransaction as any,
        url: 'https://sponsor.example/tp_key',
      }),
    ).rejects.toThrow('did not return a feeToken')
  })

  test('error: rejects hosted feeToken outside the allowlist', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              result: { tx: { feePayerSignature, feeToken: swapTokenIn } },
            }),
          ),
      ),
    )

    await expect(
      fillHostedFeePayerTransaction({
        allowedFeeTokens: defaultAllowedFeeTokens(defaults.chainId.mainnet),
        transaction: hostedTransaction as any,
        url: 'https://sponsor.example/tp_key',
      }),
    ).rejects.toThrow('feeToken is not allowed')
  })

  test('error: surfaces hosted fee payer errors', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(
        async () =>
          new Response(JSON.stringify({ error: { message: 'Invalid or revoked API key' } }), {
            status: 401,
          }),
      ),
    )

    await expect(
      fillHostedFeePayerTransaction({
        allowedFeeTokens: defaultAllowedFeeTokens(defaults.chainId.mainnet),
        transaction: hostedTransaction as any,
        url: 'https://sponsor.example/tp_key',
      }),
    ).rejects.toThrow('Invalid or revoked API key')
  })

  test('error: rejects keyAuthorization before requesting hosted fill', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)

    await expect(
      fillHostedFeePayerTransaction({
        allowedFeeTokens: defaultAllowedFeeTokens(defaults.chainId.mainnet),
        transaction: {
          ...hostedTransaction,
          keyAuthorization: {
            address: bogus,
            chainId: defaults.chainId.mainnet,
            nonce: 1n,
            r: 1n,
            s: 2n,
            yParity: 0,
          },
        } as any,
        url: 'https://sponsor.example/tp_key',
      }),
    ).rejects.toThrow('must not include keyAuthorization')
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('simulationTransaction', () => {
  test('strips signed fee-payer fields for sponsored preflight simulation', () => {
    const transaction = {
      calls: [{ to: bogus }],
      feePayerSignature,
      from: bogus,
    }

    expect(simulationTransaction(transaction as any, { feePayer: true })).toEqual({
      account: bogus,
      calls: transaction.calls,
    })
  })

  test('preserves non-sponsored transaction fields except feePayerSignature', () => {
    const transaction = {
      calls: [{ to: bogus }],
      feePayerSignature,
      from: bogus,
      gas: 1n,
    }

    expect(simulationTransaction(transaction as any, { feePayer: false })).toEqual({
      account: bogus,
      calls: transaction.calls,
      from: bogus,
      gas: 1n,
      feePayerSignature: undefined,
    })
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
    nonceKey: 'expiring',
    signature: { r: 1n, s: 1n, yParity: 0 } as any,
    validBefore: Math.floor(Date.now() / 1_000) + 300,
  } as const

  test('accepts bounded sponsored transaction fields', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        allowedFeeTokens: [bogus],
        transaction: baseTransaction as any,
      }),
    ).not.toThrow()
  })

  test('accepts serialized expiring nonce key', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        allowedFeeTokens: [bogus],
        transaction: {
          ...baseTransaction,
          nonceKey: maxUint256,
        } as any,
      }),
    ).not.toThrow()
  })

  test('error: rejects non-expiring nonce keys', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        allowedFeeTokens: [bogus],
        transaction: {
          ...baseTransaction,
          nonceKey: 1n,
        } as any,
      }),
    ).toThrow('must use an expiring nonce')
  })

  test('accepts higher Moderato priority fees by default', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        allowedFeeTokens: [bogus],
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
        allowedFeeTokens: [bogus],
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
        allowedFeeTokens: [bogus],
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
        allowedFeeTokens: [bogus],
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

  test('error: rejects keyAuthorization', () => {
    const keyAuthorization = {
      address: bogus,
      chainId: 42431,
      nonce: 1n,
      r: 1n,
      s: 2n,
      yParity: 0,
    }

    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        allowedFeeTokens: [bogus],
        transaction: { ...baseTransaction, keyAuthorization } as any,
      }),
    ).toThrow('must not include keyAuthorization')
  })

  test('error: rejects unknown top-level fields from the sponsored transaction', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        allowedFeeTokens: [bogus],
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
        allowedFeeTokens: [bogus],
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
        allowedFeeTokens: [bogus],
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
        allowedFeeTokens: [bogus],
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
        allowedFeeTokens: ['0x0000000000000000000000000000000000000002'],
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
        allowedFeeTokens: [bogus],
        transaction: {
          ...baseTransaction,
          validBefore: Math.floor(Date.now() / 1_000) + 3_600,
        } as any,
      }),
    ).toThrow('validity window exceeds sponsor policy')
  })
})
