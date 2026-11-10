import { Address, Secp256k1, Signature } from 'ox'
import { TxEnvelopeTempo } from 'ox/tempo'
import { encodeFunctionData, maxUint256, toHex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { Abis, Addresses, Transaction } from 'viem/tempo'
import { afterEach, describe, expect, test, vi } from 'vp/test'

import { PaymentSimulationError } from '../../Errors.js'
import { escrowAbi as legacyEscrowAbi } from '../legacy/session/escrow.abi.js'
import { escrowAbi } from '../session/precompile/escrow.abi.js'
import * as defaults from './defaults.js'
import {
  assertAllowedFeeToken,
  assertTransactionPolicy,
  callScopes,
  defaultAllowedFeeTokens,
  FeePayerValidationError,
  fillHostedFeePayerTransaction,
  isOutOfGasError,
  preflightSponsorship,
  prepareSponsoredTransaction,
  signFeePayerSimulation,
  simulationTransaction,
  sponsoredSimulationGas,
  sponsoredSimulationGasBuffer,
  sponsoredSimulationTransaction,
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
const sessionDescriptor = {
  payer: bogus,
  payee: bogus,
  operator: bogus,
  token: bogus,
  salt: `0x${'1'.repeat(64)}` as const,
  authorizedSigner: bogus,
  expiringNonceHash: `0x${'2'.repeat(64)}` as const,
}
const sessionCallData = [
  {
    name: 'open',
    data: encodeFunctionData({
      abi: escrowAbi,
      functionName: 'open',
      args: [bogus, bogus, bogus, 100n, sessionDescriptor.salt, bogus],
    }),
  },
  {
    name: 'topUp',
    data: encodeFunctionData({
      abi: escrowAbi,
      functionName: 'topUp',
      args: [sessionDescriptor, 100n],
    }),
  },
  {
    name: 'legacy open',
    data: encodeFunctionData({
      abi: legacyEscrowAbi,
      functionName: 'open',
      args: [bogus, bogus, 100n, sessionDescriptor.salt, bogus],
    }),
  },
  {
    name: 'legacy topUp',
    data: encodeFunctionData({
      abi: legacyEscrowAbi,
      functionName: 'topUp',
      args: [sessionDescriptor.expiringNonceHash, 100n],
    }),
  },
] as const
const feePayerSignature = {
  r: '0x0000000000000000000000000000000000000000000000000000000000000002',
  s: '0x0000000000000000000000000000000000000000000000000000000000000003',
  yParity: 1,
}
const sponsor = { address: bogus, type: 'local' } as any

afterEach(() => {
  vi.unstubAllGlobals()
})

/** Awaits a rejected preflight and returns its `PaymentSimulationError`. */
async function simulationFailure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => undefined,
    (error: unknown) => error,
  )
  expect(error).toBeInstanceOf(PaymentSimulationError)
  return error as PaymentSimulationError & { cause: Error }
}

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
    expect(
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
    ).toBe(swapTokenIn)
  })

  test.each([1n, 90n, 100n, 0n, 101n])('bounds sponsored swap output %s', (amountOut) => {
    const validate = () =>
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
            data: encodeFunctionData({
              abi: Abis.stablecoinDex,
              functionName: 'swapExactAmountOut',
              args: [swapTokenIn, swapTokenOut, amountOut, 100n],
            }),
          },
          {
            to: swapTokenOut,
            data: encodeFunctionData({
              abi: Abis.tip20,
              functionName: 'transfer',
              args: [bogus, 100n],
            }),
          },
        ],
        details,
        { currency: swapTokenOut, expectedTransfers: [{ amount: '100', recipient: bogus }] },
      )
    if (amountOut > 0n && amountOut <= 100n) expect(validate).not.toThrow()
    else expect(validate).toThrow('swap output must be positive')
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

  test('accepts arbitrary valid addresses only when the allowlist is omitted', () => {
    expect(() => assertAllowedFeeToken({ feeToken: swapTokenIn })).not.toThrow()
    expect(() => assertAllowedFeeToken({ feeToken: swapTokenIn }, [])).toThrow(
      'feeToken is not allowed',
    )
  })

  test.each(['', 'pathUSD', '0x1234', `0x${'g'.repeat(40)}`, `0x${'0'.repeat(42)}`, null, 1n])(
    'rejects malformed fee tokens without an allowlist: %s',
    (feeToken) => {
      expect(() => assertAllowedFeeToken({ feeToken })).toThrow('feeToken is invalid')
    },
  )

  test('compares valid addresses case-insensitively', () => {
    expect(() =>
      assertAllowedFeeToken({ feeToken: defaults.tokens.usdc.toLowerCase() }, [
        defaults.tokens.usdc,
      ]),
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

  test('error: rejects MACH as a fee token', () => {
    expect(() =>
      assertAllowedFeeToken(
        { feeToken: defaults.machineToken[defaults.chainId.testnet].token },
        defaultAllowedFeeTokens(defaults.chainId.testnet),
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
  const hostedContext = {
    chainId: defaults.chainId.mainnet,
    details,
  } as const

  test.each([
    { allowedFeeTokens: [defaults.tokens.pathUsd], feeToken: defaults.tokens.pathUsd },
    { allowedFeeTokens: undefined, feeToken: swapTokenIn },
    { allowedFeeTokens: [swapTokenIn], feeToken: swapTokenIn },
  ])('preserves sender-committed fields with hosted token policy %j', async (config) => {
    const { allowedFeeTokens, feeToken } = config
    // Sign over the payload built from the actual RPC request body so this
    // verifies recovery parity with the real request shape.
    const sponsorPrivateKey =
      '0x0000000000000000000000000000000000000000000000000000000000000042' as const
    const sponsorAddress = Address.fromPublicKey(
      Secp256k1.getPublicKey({ privateKey: sponsorPrivateKey }),
    )
    let realFeePayerSignature: ReturnType<typeof Secp256k1.sign> | undefined

    const request = vi.fn(async (args: any) => {
      const rpc = args.params[0]
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
            feeToken,
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
      return {
        tx: {
          feePayerSignature: realFeePayerSignature,
          feeToken,
          gas: '0x1',
          maxFeePerGas: '0x2',
          calls: [{ to: swapTokenOut, data: '0x' }],
          chainId: '0x1',
          nonce: '0x99',
        },
      }
    })
    const result = await fillHostedFeePayerTransaction({
      allowedFeeTokens,
      ...hostedContext,
      request,
      transaction: hostedTransaction as any,
    })

    expect(result.feeToken).toBe(feeToken)
    expect(result.feePayer.toLowerCase()).toBe(sponsorAddress.toLowerCase())
    const serialized = result.serializedTransaction

    expect(request).toHaveBeenCalledOnce()
    const body = request.mock.calls[0]![0]
    expect(body).toMatchObject({
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
    expect(transaction.feeToken).toBe(feeToken)
    expect(transaction.chainId).toBe(hostedTransaction.chainId)
    expect(BigInt(transaction.nonce!)).toBe(hostedTransaction.nonce)
    expect(transaction.validBefore).toBe(hostedTransaction.validBefore)
    expect(BigInt(transaction.feePayerSignature!.r)).toBe(realFeePayerSignature!.r)
    expect(BigInt(transaction.feePayerSignature!.s)).toBe(realFeePayerSignature!.s)
  })

  test('returns the sponsor signature so the final envelope can be simulated as sponsored', async () => {
    const sponsorPrivateKey =
      '0x0000000000000000000000000000000000000000000000000000000000000042' as const
    let signature: ReturnType<typeof Secp256k1.sign> | undefined
    const result = await fillHostedFeePayerTransaction({
      ...hostedContext,
      request: vi.fn(async (args: any) => {
        signature = Secp256k1.sign({
          payload: hostedFeePayerSignPayload(args.params[0], swapTokenIn),
          privateKey: sponsorPrivateKey,
        })
        // Nodes return quantities as hex, including a yParity of `0x0`.
        return { tx: { feePayerSignature: Signature.toRpc(signature), feeToken: swapTokenIn } }
      }),
      transaction: hostedTransaction as any,
    })

    expect(result.feePayerSignature).toEqual({
      r: signature!.r,
      s: signature!.s,
      yParity: signature!.yParity,
    })
    expect(
      Secp256k1.recoverAddress({
        payload: hostedFeePayerSignPayload(await hostedRequest(hostedTransaction), swapTokenIn),
        signature: result.feePayerSignature,
      }).toLowerCase(),
    ).toBe(result.feePayer.toLowerCase())
  })

  test.each([0, 1])(
    'decodes a hosted signature whose yParity is %i, including the falsy 0',
    async (yParity) => {
      const sponsorPrivateKey =
        '0x0000000000000000000000000000000000000000000000000000000000000043' as const
      // Search nonces for a signature with the wanted parity, so both encodings are covered.
      let nonce = 1n
      let signature: ReturnType<typeof Secp256k1.sign>
      for (;;) {
        const rpc = await hostedRequest({ ...hostedTransaction, nonce })
        signature = Secp256k1.sign({
          payload: hostedFeePayerSignPayload(rpc, swapTokenIn),
          privateKey: sponsorPrivateKey,
        })
        if (signature.yParity === yParity) break
        nonce += 1n
      }
      const result = await fillHostedFeePayerTransaction({
        ...hostedContext,
        request: vi.fn(async () => ({
          tx: {
            feePayerSignature: { ...Signature.toRpc(signature), yParity },
            feeToken: swapTokenIn,
          },
        })),
        transaction: { ...hostedTransaction, nonce } as any,
      })

      expect(result.feePayerSignature.yParity).toBe(yParity)
      expect(result.feePayerSignature.r).toBe(signature.r)
    },
  )

  test('error: requires hosted fee payer to return a feeToken', async () => {
    await expect(
      fillHostedFeePayerTransaction({
        ...hostedContext,
        request: vi.fn(async () => ({ tx: { feePayerSignature } })),
        transaction: hostedTransaction as any,
      }),
    ).rejects.toThrow('did not return a feeToken')
  })

  test.each(['not-an-address', '0x1234', `0x${'g'.repeat(40)}`])(
    'error: rejects malformed hosted feeToken without an allowlist: %s',
    async (feeToken) => {
      await expect(
        fillHostedFeePayerTransaction({
          ...hostedContext,
          request: vi.fn(async () => ({ tx: { feePayerSignature, feeToken } })),
          transaction: hostedTransaction as any,
        }),
      ).rejects.toThrow('feeToken is invalid')
    },
  )

  test.each([undefined, null, { tx: {} }, { tx: { feeToken: swapTokenIn } }])(
    'error: requires a hosted sponsor signature without an allowlist: %j',
    async (result) => {
      await expect(
        fillHostedFeePayerTransaction({
          ...hostedContext,
          request: vi.fn(async () => result),
          transaction: hostedTransaction as any,
        }),
      ).rejects.toThrow('failed to sponsor transaction')
    },
  )

  test('error: rejects an invalid hosted signature without an allowlist', async () => {
    await expect(
      fillHostedFeePayerTransaction({
        ...hostedContext,
        request: vi.fn(async () => ({
          tx: { feePayerSignature: { r: '0x0', s: '0x0', yParity: 0 }, feeToken: swapTokenIn },
        })),
        transaction: hostedTransaction as any,
      }),
    ).rejects.toThrow('invalid feePayerSignature')
  })

  test('error: rejects hosted feeToken outside the allowlist', async () => {
    await expect(
      fillHostedFeePayerTransaction({
        allowedFeeTokens: defaultAllowedFeeTokens(defaults.chainId.mainnet),
        ...hostedContext,
        request: vi.fn(async () => ({
          tx: { feePayerSignature, feeToken: swapTokenIn },
        })),
        transaction: hostedTransaction as any,
      }),
    ).rejects.toThrow('feeToken is not allowed')
  })

  test('error: surfaces hosted fee payer errors', async () => {
    await expect(
      fillHostedFeePayerTransaction({
        ...hostedContext,
        request: vi.fn(async () => {
          throw new Error('Invalid or revoked API key')
        }),
        transaction: hostedTransaction as any,
      }),
    ).rejects.toThrow('Invalid or revoked API key')
  })

  test('error: enforces sponsor policy before requesting hosted fill', async () => {
    const request = vi.fn()

    await expect(
      fillHostedFeePayerTransaction({
        ...hostedContext,
        policy: { maxGas: hostedTransaction.gas - 1n },
        request,
        transaction: hostedTransaction as any,
      }),
    ).rejects.toThrow('gas exceeds sponsor policy')
    expect(request).not.toHaveBeenCalled()
  })

  test('error: rejects non-empty access lists before requesting hosted fill', async () => {
    const request = vi.fn()

    await expect(
      fillHostedFeePayerTransaction({
        ...hostedContext,
        request,
        transaction: {
          ...hostedTransaction,
          accessList: [{ address: bogus, storageKeys: [] }],
        } as any,
      }),
    ).rejects.toThrow('accessList is not allowed')
    expect(request).not.toHaveBeenCalled()
  })

  test('error: rejects padded calldata before requesting hosted fill', async () => {
    const request = vi.fn()

    await expect(
      fillHostedFeePayerTransaction({
        ...hostedContext,
        request,
        transaction: {
          ...hostedTransaction,
          calls: [
            {
              ...hostedTransaction.calls[0],
              data: `${hostedTransaction.calls[0]!.data}01`,
            },
          ],
        } as any,
      }),
    ).rejects.toThrow('calldata is not canonical')
    expect(request).not.toHaveBeenCalled()
  })

  test('error: rejects unknown calldata before requesting hosted fill', async () => {
    const request = vi.fn()

    await expect(
      fillHostedFeePayerTransaction({
        ...hostedContext,
        request,
        transaction: {
          ...hostedTransaction,
          calls: [{ ...hostedTransaction.calls[0], data: '0xdeadbeef' }],
        } as any,
      }),
    ).rejects.toThrow('call calldata is invalid')
    expect(request).not.toHaveBeenCalled()
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
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
    })
  })

  test('keeps the broadcast gas limit and intrinsic-gas fields with zero fees', () => {
    const keyAuthorization = { address: bogus } as any
    const transaction = {
      calls: [{ to: bogus }],
      feePayerSignature,
      feeToken: swapTokenIn,
      from: bogus,
      gas: 67_894n,
      keyAuthorization,
      maxFeePerGas: 20_000_000_000n,
      maxPriorityFeePerGas: 1n,
      nonce: 0n,
      nonceKey: maxUint256,
      signature: { type: 'keychain', inner: { type: 'webAuthn' } },
      validAfter: 1,
      validBefore: 1_800_000_000,
    }

    expect(simulationTransaction(transaction as any, { feePayer: true })).toEqual({
      account: bogus,
      calls: transaction.calls,
      gas: 67_894n,
      keyAuthorization,
      keyType: 'webAuthn',
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      nonce: 0n,
      nonceKey: maxUint256,
      validAfter: 1,
      validBefore: 1_800_000_000,
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

  test('builds the final sponsored envelope without either signature', () => {
    const transaction = {
      calls: [{ to: bogus }],
      feePayerSignature,
      feeToken: swapTokenIn,
      from: bogus,
      signature: { r: 1n, s: 2n, yParity: 0 },
    }

    expect(
      sponsoredSimulationTransaction(transaction as any, {
        feePayer: swapTokenOut,
        feeToken: bogus,
      }),
    ).toEqual({
      ...transaction,
      account: bogus,
      calls: transaction.calls,
      feePayer: swapTokenOut,
      feePayerSignature: undefined,
      feeToken: bogus,
      maxPriorityFeePerGas: 0n,
      signature: undefined,
    })
  })
})

describe('sponsoredSimulationTransaction', () => {
  test('carries the sponsor signature in RPC form so the node bills the sponsor', () => {
    const transaction = {
      calls: [{ to: bogus }],
      from: bogus,
      signature: { r: 1n, s: 2n, yParity: 0 },
    }
    const signature = { r: 5n, s: 6n, yParity: 1 }

    expect(
      sponsoredSimulationTransaction(transaction as any, {
        feePayer: swapTokenOut,
        feePayerSignature: signature,
        feeToken: swapTokenIn,
      }),
    ).toEqual({
      account: bogus,
      calls: transaction.calls,
      feePayer: swapTokenOut,
      feePayerSignature: {
        r: '0x0000000000000000000000000000000000000000000000000000000000000005',
        s: '0x0000000000000000000000000000000000000000000000000000000000000006',
        yParity: '0x1',
      },
      feeToken: swapTokenIn,
      from: bogus,
      maxPriorityFeePerGas: 0n,
      signature: undefined,
    })
  })

  test('replaces a stale envelope signature with the one passed in', () => {
    const transaction = { calls: [{ to: bogus }], feePayerSignature, from: bogus }
    const signature = { r: 7n, s: 8n, yParity: 0 }

    const request = sponsoredSimulationTransaction(transaction as any, {
      feePayer: swapTokenOut,
      feePayerSignature: signature,
    })

    expect(request.feePayerSignature).toEqual(Signature.toRpc(signature))
  })
})

describe('signFeePayerSimulation', () => {
  const sender = privateKeyToAccount(
    '0x0000000000000000000000000000000000000000000000000000000000000051',
  )
  const feePayer = privateKeyToAccount(
    '0x0000000000000000000000000000000000000000000000000000000000000052',
  )
  const transaction = {
    calls: [
      {
        data: encodeFunctionData({ abi: Abis.tip20, functionName: 'transfer', args: [bogus, 1n] }),
        to: defaults.tokens.pathUsd,
      },
    ],
    chainId: defaults.chainId.mainnet,
    feeToken: defaults.tokens.pathUsd,
    from: sender.address,
    gas: 100_000n,
    maxFeePerGas: 2_000_000_000n,
    maxPriorityFeePerGas: 0n,
    nonce: 0n,
    nonceKey: maxUint256,
    type: 'tempo' as const,
    validBefore: 1_800_000_000,
  }

  test('signs the same payload Transaction.serialize signs for a local fee payer', async () => {
    const serialized = await Transaction.serialize(
      { ...transaction, feePayer } as any,
      { r: 1n, s: 1n, yParity: 0 } as any,
    )
    const broadcast = Transaction.deserialize(serialized as Transaction.TransactionSerializedTempo)

    const signature = await signFeePayerSimulation({
      ...transaction,
      account: sender,
      feePayer,
    } as any)

    expect(signature).toEqual({
      r: BigInt(broadcast.feePayerSignature!.r),
      s: BigInt(broadcast.feePayerSignature!.s),
      yParity: Number(broadcast.feePayerSignature!.yParity),
    })
  })

  test('recovers to the fee payer address', async () => {
    const signature = await signFeePayerSimulation({ ...transaction, feePayer } as any)
    const payload = TxEnvelopeTempo.getFeePayerSignPayload(
      TxEnvelopeTempo.from(transaction as any) as any,
      { sender: sender.address },
    )

    expect(Secp256k1.recoverAddress({ payload, signature: signature! }).toLowerCase()).toBe(
      feePayer.address.toLowerCase(),
    )
  })

  test.each([
    { case: 'an address', feePayer: bogus },
    { case: 'true', feePayer: true },
    { case: 'a json-rpc account', feePayer: { address: bogus, type: 'json-rpc' } },
    { case: 'missing', feePayer: undefined },
  ])('returns undefined when the fee payer is $case', async ({ feePayer }) => {
    expect(await signFeePayerSimulation({ ...transaction, feePayer } as any)).toBeUndefined()
  })

  test('returns undefined without a sender', async () => {
    const { from: _, ...rest } = transaction
    expect(await signFeePayerSimulation({ ...rest, feePayer } as any)).toBeUndefined()
  })
})

describe('preflightSponsorship', () => {
  const transaction = {
    calls: [{ to: bogus }],
    feeToken: swapTokenIn,
    from: bogus,
  }

  test('simulates the sender before completion and the completed envelope after', async () => {
    const simulations: Record<string, unknown>[] = []
    let completions = 0

    const result = await preflightSponsorship({
      transaction: transaction as any,
      async simulate(request) {
        simulations.push(request)
      },
      async complete() {
        completions += 1
        return { feePayer: swapTokenOut, transaction: transaction as any }
      },
    })

    expect(completions).toBe(1)
    expect(result.feePayer).toBe(swapTokenOut)
    expect(simulations).toEqual([
      { account: bogus, calls: transaction.calls, maxFeePerGas: 0n, maxPriorityFeePerGas: 0n },
      {
        ...transaction,
        account: bogus,
        calls: transaction.calls,
        feePayer: swapTokenOut,
        feePayerSignature: undefined,
        maxPriorityFeePerGas: 0n,
        signature: undefined,
      },
    ])
  })

  test.each([
    { completeCalls: 0, failingSimulation: 1, simulationCalls: 1 },
    { completeCalls: 1, failingSimulation: 2, simulationCalls: 2 },
  ])(
    'stops at simulation $failingSimulation',
    async ({ completeCalls, failingSimulation, simulationCalls }) => {
      let completions = 0
      let simulations = 0

      await expect(
        preflightSponsorship({
          transaction: transaction as any,
          async simulate() {
            simulations += 1
            if (simulations === failingSimulation) throw new Error('simulation failed')
          },
          async complete() {
            completions += 1
            return { feePayer: swapTokenOut, transaction: transaction as any }
          },
        }),
      ).rejects.toThrow('simulation failed')

      expect(completions).toBe(completeCalls)
      expect(simulations).toBe(simulationCalls)
    },
  )

  test('simulates the completed envelope with the hosted sponsor signature', async () => {
    const simulations: Record<string, unknown>[] = []
    const signature = { r: 9n, s: 10n, yParity: 0 }

    await preflightSponsorship({
      transaction: transaction as any,
      async simulate(request) {
        simulations.push(request)
      },
      async complete() {
        return {
          feePayer: swapTokenOut,
          feePayerSignature: signature,
          feeToken: defaults.tokens.pathUsd,
          transaction: transaction as any,
        }
      },
    })

    expect(simulations[1]).toMatchObject({
      feePayer: swapTokenOut,
      feePayerSignature: Signature.toRpc(signature),
      feeToken: defaults.tokens.pathUsd,
      signature: undefined,
    })
  })

  test('signs the simulation with a local fee payer after the sender simulation passes', async () => {
    const feePayer = privateKeyToAccount(
      '0x0000000000000000000000000000000000000000000000000000000000000053',
    )
    const events: string[] = []
    const local = {
      ...feePayer,
      async sign(parameters: { hash: `0x${string}` }) {
        events.push('sign')
        return feePayer.sign(parameters)
      },
    }
    const completedTransaction = {
      calls: [{ to: bogus }],
      chainId: defaults.chainId.mainnet,
      feePayer: local,
      feeToken: defaults.tokens.pathUsd,
      from: bogus,
      gas: 1n,
      maxFeePerGas: 1n,
      nonce: 0n,
      nonceKey: maxUint256,
      type: 'tempo',
      validBefore: 1_800_000_000,
    }
    const simulations: Record<string, any>[] = []

    const completed = await preflightSponsorship({
      transaction: transaction as any,
      async simulate(request) {
        events.push('simulate')
        simulations.push(request)
      },
      async complete() {
        events.push('complete')
        return { feePayer: feePayer.address, transaction: completedTransaction as any }
      },
    })

    expect(events).toEqual(['simulate', 'complete', 'sign', 'simulate'])
    // The simulation-only copy carries the gas buffer; the returned envelope keeps its gas.
    const simulatedGas = completedTransaction.gas + sponsoredSimulationGasBuffer
    expect(simulations[1]!.gas).toBe(simulatedGas)
    expect((completed.transaction as any).gas).toBe(completedTransaction.gas)
    const payload = TxEnvelopeTempo.getFeePayerSignPayload(
      TxEnvelopeTempo.from({
        ...completedTransaction,
        feePayer: undefined,
        gas: simulatedGas,
      } as any) as any,
      { sender: bogus },
    )
    expect(
      Secp256k1.recoverAddress({
        payload,
        signature: Signature.fromRpc(simulations[1]!.feePayerSignature),
      }).toLowerCase(),
    ).toBe(feePayer.address.toLowerCase())
  })

  test('prefers the completed signature over signing locally', async () => {
    const sign = vi.fn()
    const signature = { r: 11n, s: 12n, yParity: 1 }
    const simulations: Record<string, any>[] = []

    await preflightSponsorship({
      transaction: transaction as any,
      async simulate(request) {
        simulations.push(request)
      },
      async complete() {
        return {
          feePayer: swapTokenOut,
          feePayerSignature: signature,
          transaction: { ...transaction, feePayer: { address: swapTokenOut, sign } } as any,
        }
      },
    })

    expect(sign).not.toHaveBeenCalled()
    expect(simulations[1]!.feePayerSignature).toEqual(Signature.toRpc(signature))
  })

  test('never signs when the sender simulation fails', async () => {
    const sign = vi.fn()

    const error = await simulationFailure(
      preflightSponsorship({
        transaction: transaction as any,
        async simulate() {
          throw new Error('sender reverted')
        },
        async complete() {
          return {
            feePayer: swapTokenOut,
            transaction: { ...transaction, feePayer: { address: swapTokenOut, sign } } as any,
          }
        },
      }),
    )
    expect(error.cause.message).toBe('sender reverted')
    expect(sign).not.toHaveBeenCalled()
  })

  test('simulates a hosted envelope with its omitted zero priority fee', async () => {
    const signature = { r: 13n, s: 14n, yParity: 0 }
    const simulations: Record<string, unknown>[] = []
    // A deserialized envelope drops a zero priority fee; the hosted signature covers it as 0.
    const { maxPriorityFeePerGas: _, ...hosted } = {
      ...transaction,
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 0n,
    }

    await preflightSponsorship({
      transaction: transaction as any,
      async simulate(request) {
        simulations.push(request)
      },
      async complete() {
        return { feePayer: swapTokenOut, feePayerSignature: signature, transaction: hosted as any }
      },
    })

    expect(simulations[1]).toMatchObject({
      feePayerSignature: Signature.toRpc(signature),
      maxFeePerGas: 1n,
      maxPriorityFeePerGas: 0n,
    })
  })

  test('tags a sender simulation failure with the payer and payment token', async () => {
    const cause = new Error('insufficient balance')
    const transfer = {
      ...transaction,
      calls: [
        {
          data: encodeFunctionData({
            abi: Abis.tip20,
            functionName: 'transfer',
            args: [bogus, 1n],
          }),
          to: defaults.tokens.pathUsd,
        },
      ],
    }
    const complete = vi.fn()

    const error = await simulationFailure(
      preflightSponsorship({
        transaction: transfer as any,
        async simulate() {
          throw cause
        },
        complete,
      }),
    )

    expect(error.message).toBe('Payment simulation failed')
    expect(error.name).toBe('PaymentSimulationError')
    expect(error.cause).toBe(cause)
    expect(error.phase).toBe('sender')
    expect(error.sender).toBe(bogus)
    expect(error.paymentToken).toBe(defaults.tokens.pathUsd)
    expect(error.feePayer).toBeUndefined()
    expect(complete).not.toHaveBeenCalled()
  })

  test('rethrows a transport failure as it is, in either phase', async () => {
    const timeout = Object.assign(new Error('The request took too long to respond.'), {
      name: 'TimeoutError',
    })
    const wrapped = new Error('call failed', { cause: timeout })
    const complete = vi.fn()

    await expect(
      preflightSponsorship({
        transaction: transaction as any,
        async simulate() {
          throw wrapped
        },
        complete,
      }),
    ).rejects.toBe(wrapped)
    expect(complete).not.toHaveBeenCalled()

    const unavailable = Object.assign(new Error('HTTP request failed. Status: 503'), {
      name: 'HttpRequestError',
    })
    let calls = 0
    await expect(
      preflightSponsorship({
        transaction: transaction as any,
        async simulate() {
          if (calls++ === 1) throw unavailable
        },
        async complete() {
          return { feePayer: transaction.from, transaction } as any
        },
      }),
    ).rejects.toBe(unavailable)
  })

  test('tags a sponsored simulation failure with the fee payer', async () => {
    const cause = new Error('insufficient fee token balance')
    const memoTransfer = {
      ...transaction,
      calls: [
        {
          data: encodeFunctionData({
            abi: Abis.tip20,
            functionName: 'transferWithMemo',
            args: [bogus, 1n, `0x${'0'.repeat(64)}`],
          }),
          to: defaults.tokens.pathUsd,
        },
      ],
    }

    const error = await simulationFailure(
      preflightSponsorship({
        transaction: memoTransfer as any,
        async simulate(request) {
          if (request.feePayer) throw cause
        },
        async complete() {
          return { feePayer: swapTokenOut, transaction: memoTransfer as any }
        },
      }),
    )

    expect(error.cause).toBe(cause)
    expect(error.phase).toBe('sponsored')
    expect(error.sender).toBe(bogus)
    expect(error.feePayer).toBe(swapTokenOut)
    expect(error.paymentToken).toBe(defaults.tokens.pathUsd)
  })

  test('omits the payment token when the transaction is not a single transfer', async () => {
    const error = await simulationFailure(
      preflightSponsorship({
        transaction: { ...transaction, calls: [{ data: swapData, to: bogus }] } as any,
        async simulate() {
          throw new Error('reverted')
        },
        complete: vi.fn(),
      }),
    )

    expect(error.paymentToken).toBeUndefined()
  })
})

describe('preflightSponsorship gas bounds', () => {
  const feePayer = privateKeyToAccount(
    '0x0000000000000000000000000000000000000000000000000000000000000054',
  )
  const sender = { calls: [{ to: bogus }], feeToken: swapTokenIn, from: bogus }
  const signed = (gas: bigint, maxFeePerGas = 1n) => ({
    calls: [{ to: bogus }],
    chainId: defaults.chainId.mainnet,
    feePayer,
    feeToken: defaults.tokens.pathUsd,
    from: bogus,
    gas,
    maxFeePerGas,
    nonce: 0n,
    nonceKey: maxUint256,
    type: 'tempo',
    validBefore: 1_800_000_000,
  })
  // Tempo nodes report both errors with code -32003, wrapped by viem.
  const rpcError = (message: string) =>
    Object.assign(new Error('Execution reverted.'), {
      cause: Object.assign(new Error('RPC Request failed.'), { details: message }),
    })
  const outOfGas = () =>
    rpcError('out of gas: gas exhausted during precompiled contract execution: 44069')
  const insufficientBalance = () =>
    rpcError('insufficient fee token balance: required 922, but only have 0')

  test('rejects a gas limit too low for the sender calls before completion', async () => {
    const transaction = { ...sender, gas: 44_069n, nonce: 0n, nonceKey: maxUint256 }
    const complete = vi.fn()
    const simulations: Record<string, any>[] = []

    const error = await simulationFailure(
      preflightSponsorship({
        transaction: transaction as any,
        async simulate(request) {
          simulations.push(request)
          // The sender's calls need 46,069 gas.
          if ((request.gas as bigint) < 46_069n) throw outOfGas()
        },
        complete,
      }),
    )
    expect(error.phase).toBe('sender')
    expect(isOutOfGasError(error.cause)).toBe(true)
    expect(simulations[0]).toMatchObject({ gas: 44_069n, maxFeePerGas: 0n, nonceKey: maxUint256 })
    expect(complete).not.toHaveBeenCalled()
  })

  test('rejects a local fee payer when the padded sponsored simulation runs out of gas', async () => {
    const error = await simulationFailure(
      preflightSponsorship({
        transaction: { ...sender, gas: 50_000n } as any,
        async simulate(request) {
          if (request.feePayerSignature) throw outOfGas()
        },
        async complete() {
          return { feePayer: feePayer.address, transaction: signed(50_000n) as any }
        },
      }),
    )
    expect(error.phase).toBe('sponsored')
    expect(isOutOfGasError(error.cause)).toBe(true)
  })

  test('clamps the padded simulation copy to the policy maxGas', async () => {
    const simulations: Record<string, any>[] = []
    const completed = await preflightSponsorship({
      policy: { maxGas: 55_000n },
      transaction: { ...sender, gas: 50_000n } as any,
      async simulate(request) {
        simulations.push(request)
      },
      async complete() {
        return { feePayer: feePayer.address, transaction: signed(50_000n) as any }
      },
    })

    expect(simulations[0]!.gas).toBe(50_000n)
    expect(simulations[1]!.gas).toBe(55_000n)
    expect((completed.transaction as any).gas).toBe(50_000n)
  })

  test('clamps the padded simulation copy to the policy maxTotalFee', () => {
    // 52,000 * 1,000 = maxTotalFee: the copy may not go above 52,000 gas.
    expect(
      sponsoredSimulationGas(signed(50_000n, 1_000n) as any, { maxTotalFee: 52_000_000n }),
    ).toBe(52_000n)
    expect(sponsoredSimulationGas(signed(50_000n, 1_000n) as any)).toBe(
      50_000n + sponsoredSimulationGasBuffer,
    )
  })

  test('never signs a copy for a transaction already over the policy caps', () => {
    expect(() => sponsoredSimulationGas(signed(60_000n) as any, { maxGas: 55_000n })).toThrow(
      'gas exceeds sponsor policy',
    )
    expect(() =>
      sponsoredSimulationGas(signed(60_000n, 1_000n) as any, { maxTotalFee: 59_999_999n }),
    ).toThrow('gas exceeds sponsor policy')
  })

  test('tolerates out of gas in a clamped local sponsored simulation', async () => {
    await expect(
      preflightSponsorship({
        policy: { maxGas: 50_000n },
        transaction: { ...sender, gas: 50_000n } as any,
        async simulate(request) {
          if (request.feePayerSignature) throw outOfGas()
        },
        async complete() {
          return { feePayer: feePayer.address, transaction: signed(50_000n) as any }
        },
      }),
    ).resolves.toMatchObject({ feePayer: feePayer.address })
  })

  test.each([
    { case: 'out of gas', error: outOfGas },
    { case: 'intrinsic gas too low', error: () => rpcError('intrinsic gas too low') },
  ])('tolerates $case in the hosted sponsored simulation', async ({ error }) => {
    const signature = { r: 9n, s: 10n, yParity: 0 }
    await expect(
      preflightSponsorship({
        transaction: { ...sender, gas: 50_000n } as any,
        async simulate(request) {
          if (request.feePayerSignature) throw error()
        },
        async complete() {
          return {
            feePayer: swapTokenOut,
            feePayerSignature: signature,
            transaction: { ...sender, gas: 50_000n } as any,
          }
        },
      }),
    ).resolves.toMatchObject({ feePayer: swapTokenOut })
  })

  test.each([
    { case: 'an insufficient fee balance', error: insufficientBalance },
    { case: 'a revert', error: () => rpcError('execution reverted') },
  ])('rejects $case in the hosted sponsored simulation', async ({ error }) => {
    const signature = { r: 9n, s: 10n, yParity: 0 }
    const failure = await simulationFailure(
      preflightSponsorship({
        transaction: { ...sender, gas: 50_000n } as any,
        async simulate(request) {
          if (request.feePayerSignature) throw error()
        },
        async complete() {
          return {
            feePayer: swapTokenOut,
            feePayerSignature: signature,
            transaction: { ...sender, gas: 50_000n } as any,
          }
        },
      }),
    )
    expect(failure.phase).toBe('sponsored')
    expect(failure.cause.message).toBe('Execution reverted.')
  })

  test('isOutOfGasError matches only out-of-gas messages', () => {
    expect(isOutOfGasError(outOfGas())).toBe(true)
    expect(isOutOfGasError(new Error('intrinsic gas too low'))).toBe(true)
    expect(isOutOfGasError(insufficientBalance())).toBe(false)
    expect(isOutOfGasError(undefined)).toBe(false)
  })

  test('isOutOfGasError ignores gas keywords outside the node message', () => {
    // A revert reason that mentions gas is a revert, not gas exhaustion.
    expect(isOutOfGasError(rpcError('execution reverted: out of gas'))).toBe(false)
    // A wrapper mentioning out of gas must not hide an underlying balance failure.
    const wrapped = Object.assign(new Error('simulation ran out of gas'), {
      cause: insufficientBalance(),
    })
    expect(isOutOfGasError(wrapped)).toBe(false)
    // Revert data on any error in the chain means the call reverted.
    const withData = Object.assign(outOfGas(), { data: '0x08c379a0' })
    expect(isOutOfGasError(withData)).toBe(false)
    // The node's own message still matches through viem's wrappers.
    const wrappedOutOfGas = Object.assign(new Error('Execution reverted.'), { cause: outOfGas() })
    expect(isOutOfGasError(wrappedOutOfGas)).toBe(true)
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

  test.each([
    [0, 14, false],
    [0, 15, true],
    [1, 15, false],
    [1, 16, true],
    [999, 16, true],
  ])('minimum validity at offset %i and remaining %i', (milliseconds, remaining, accepted) => {
    const now = new Date(2_000_000_000_000 + milliseconds)
    const validate = () =>
      assertTransactionPolicy({
        chainId: 42431,
        details,
        now,
        transaction: { ...baseTransaction, validBefore: 2_000_000_000 + remaining } as any,
      })
    if (accepted) expect(validate).not.toThrow()
    else expect(validate).toThrow('at least 15 seconds')
  })

  test.each([0, 1, 999])('accepts a 15-second maximum at millisecond offset %i', (offset) => {
    const now = new Date(2_000_000_000_000 + offset)
    expect(() =>
      assertTransactionPolicy({
        chainId: 42431,
        details,
        now,
        policy: { maxValidityWindowSeconds: 15 },
        transaction: {
          ...baseTransaction,
          validBefore: Math.ceil(now.getTime() / 1_000) + 15,
        } as any,
      }),
    ).not.toThrow()
  })

  test.each([0, 14, 14.5, NaN, Infinity])(
    'rejects an incompatible maximum window %s',
    (maximum) => {
      expect(() =>
        assertTransactionPolicy({
          chainId: 42431,
          details,
          policy: { maxValidityWindowSeconds: maximum },
          transaction: baseTransaction as any,
        }),
      ).toThrow('maxValidityWindowSeconds must be an integer of at least 15 seconds')
    },
  )

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
      allowedFeeTokens: [bogus],
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

  test('error: rejects non-empty access lists', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        allowedFeeTokens: [bogus],
        transaction: {
          ...baseTransaction,
          accessList: [{ address: bogus, storageKeys: [] }],
        } as any,
      }),
    ).toThrow('accessList is not allowed')
  })

  test.each(sessionCallData)('accepts canonical session $name calldata', ({ data }) => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        allowedFeeTokens: [bogus],
        transaction: {
          ...baseTransaction,
          calls: [{ ...baseTransaction.calls[0], data }],
        } as any,
      }),
    ).not.toThrow()
  })

  test.each(sessionCallData)('error: rejects padded session $name calldata', ({ data }) => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        allowedFeeTokens: [bogus],
        transaction: {
          ...baseTransaction,
          calls: [{ ...baseTransaction.calls[0], data: `${data}00` }],
        } as any,
      }),
    ).toThrow('calldata is not canonical')
  })

  test('error: rejects unknown call calldata', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        allowedFeeTokens: [bogus],
        transaction: {
          ...baseTransaction,
          calls: [{ ...baseTransaction.calls[0], data: '0xdeadbeef' }],
        } as any,
      }),
    ).toThrow('call calldata is invalid')
  })

  test('error: rejects known but unsupported call calldata', () => {
    const data = encodeFunctionData({
      abi: Abis.tip20,
      functionName: 'balanceOf',
      args: [bogus],
    })
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        allowedFeeTokens: [bogus],
        transaction: {
          ...baseTransaction,
          calls: [{ ...baseTransaction.calls[0], data }],
        } as any,
      }),
    ).toThrow('call calldata is invalid')
  })

  test('error: rejects padded calldata', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        allowedFeeTokens: [bogus],
        transaction: {
          ...baseTransaction,
          calls: [
            {
              ...baseTransaction.calls[0],
              data: `${baseTransaction.calls[0]!.data}01`,
            },
          ],
        } as any,
      }),
    ).toThrow('calldata is not canonical')
  })

  test('error: rejects missing calls', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        allowedFeeTokens: [bogus],
        transaction: {
          ...baseTransaction,
          calls: undefined,
        } as any,
      }),
    ).toThrow('must declare calls')
  })

  test('error: rejects nonzero call value', () => {
    expect(() =>
      prepareSponsoredTransaction({
        account: sponsor,
        chainId: 42431,
        details,
        allowedFeeTokens: [bogus],
        transaction: {
          ...baseTransaction,
          calls: [{ ...baseTransaction.calls[0], value: 1n }],
        } as any,
      }),
    ).toThrow('call value is not allowed')
  })
})

/** Captures the `eth_fillTransaction` request body that `fillHostedFeePayerTransaction` sends. */
async function hostedRequest(transaction: Record<string, any>): Promise<Record<string, any>> {
  let body: Record<string, any> | undefined
  await fillHostedFeePayerTransaction({
    chainId: defaults.chainId.mainnet,
    details,
    request: async (args: any) => {
      body = args.params[0]
      throw new Error('captured')
    },
    transaction: transaction as any,
  }).catch(() => {})
  return body!
}

/** The fee-payer payload a hosted sponsor signs for an `eth_fillTransaction` request body. */
function hostedFeePayerSignPayload(rpc: Record<string, any>, feeToken: `0x${string}`) {
  const quantity = (value: unknown) => (value === undefined ? undefined : BigInt(value as string))
  return TxEnvelopeTempo.getFeePayerSignPayload(
    TxEnvelopeTempo.from({
      accessList: rpc.accessList,
      calls: rpc.calls.map(({ value, ...call }: any) => ({
        ...call,
        ...(value && value !== '0x' ? { value: BigInt(value) } : {}),
      })),
      chainId: defaults.chainId.mainnet,
      feeToken,
      from: rpc.from,
      gas: quantity(rpc.gas),
      maxFeePerGas: quantity(rpc.maxFeePerGas),
      maxPriorityFeePerGas: quantity(rpc.maxPriorityFeePerGas),
      nonce: quantity(rpc.nonce),
      nonceKey: quantity(rpc.nonceKey),
      type: 'tempo',
      validBefore: rpc.validBefore === undefined ? undefined : Number(BigInt(rpc.validBefore)),
    } as any) as any,
    { sender: rpc.from },
  )
}
