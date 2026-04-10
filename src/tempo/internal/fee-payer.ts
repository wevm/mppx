import type { TempoAddress } from 'ox/tempo'
import { TxEnvelopeTempo } from 'ox/tempo'
import type { Account } from 'viem'
import { decodeFunctionData } from 'viem'
import { Abis, Addresses, Transaction } from 'viem/tempo'

import * as TempoAddress_internal from './address.js'
import * as Selectors from './selectors.js'

/** Returns true if the serialized transaction has a Tempo envelope prefix. */
export function isTempoTransaction(serialized: string | undefined): boolean {
  return (
    serialized?.startsWith(TxEnvelopeTempo.serializedType) === true ||
    serialized?.startsWith(TxEnvelopeTempo.feePayerMagic) === true
  )
}

/**
 * Allowed call patterns for fee-payer sponsored transactions.
 * Each inner array is an ordered list of function selectors.
 */
export const callScopes = [
  [Selectors.transfer],
  [Selectors.transferWithMemo],
  [Selectors.approve, Selectors.swapExactAmountOut, Selectors.transfer],
  [Selectors.approve, Selectors.swapExactAmountOut, Selectors.transferWithMemo],
]

const policy = {
  maxGas: 2_000_000n, // 2M gas units
  maxFeePerGas: 100_000_000_000n, // 100 gwei
  maxPriorityFeePerGas: 10_000_000_000n, // 10 gwei
  maxTotalFee: 50_000_000_000_000_000n, // 0.05 ETH
  maxValidityWindowSeconds: 15 * 60, // 15 minutes
} as const

/** Validates that a set of transaction calls matches an allowed fee-payer pattern. */
export function validateCalls(
  calls: readonly { data?: `0x${string}` | undefined; to?: TempoAddress.Address | undefined }[],
  details: Record<string, string>,
) {
  if (calls.length === 0)
    throw new FeePayerValidationError('disallowed call pattern in fee-payer transaction', details)

  const callSelectors = calls.map((c) => c.data?.slice(0, 10))
  const hasSwapPrefix = callSelectors[0] === Selectors.approve

  if (hasSwapPrefix) {
    if (callSelectors[1] !== Selectors.swapExactAmountOut)
      throw new FeePayerValidationError('disallowed call pattern in fee-payer transaction', details)
  } else if (callSelectors[0] === Selectors.swapExactAmountOut) {
    throw new FeePayerValidationError('disallowed call pattern in fee-payer transaction', details)
  }

  const transferSelectors = callSelectors.slice(hasSwapPrefix ? 2 : 0)
  if (
    transferSelectors.length === 0 ||
    transferSelectors.length > 11 ||
    transferSelectors.some(
      (selector) => selector !== Selectors.transfer && selector !== Selectors.transferWithMemo,
    )
  ) {
    throw new FeePayerValidationError('disallowed call pattern in fee-payer transaction', details)
  }

  // Validate approve spender and buy target are the DEX.
  const approveCall = calls.find((c) => c.data?.slice(0, 10) === Selectors.approve)
  if (approveCall) {
    const { args } = decodeFunctionData({ abi: Abis.tip20, data: approveCall.data! })
    if (!TempoAddress_internal.isEqual((args as [`0x${string}`])[0]!, Addresses.stablecoinDex))
      throw new FeePayerValidationError('approve spender is not the DEX', details)
  }
  const buyCall = calls.find((c) => c.data?.slice(0, 10) === Selectors.swapExactAmountOut)
  if (
    buyCall &&
    (!buyCall.to || !TempoAddress_internal.isEqual(buyCall.to, Addresses.stablecoinDex))
  )
    throw new FeePayerValidationError('buy target is not the DEX', details)
}

export function prepareSponsoredTransaction(parameters: {
  account: Account
  challengeExpires?: string | undefined
  chainId: number
  details: Record<string, string>
  expectedFeeToken?: TempoAddress.Address | undefined
  now?: Date | undefined
  transaction: ReturnType<(typeof Transaction)['deserialize']>
}) {
  const {
    account,
    challengeExpires,
    chainId,
    details,
    expectedFeeToken,
    now = new Date(),
    transaction,
  } = parameters

  const {
    accessList,
    calls,
    chainId: transactionChainId,
    feeToken,
    from,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce,
    nonceKey,
    signature,
    validAfter,
    validBefore,
  } = transaction

  const fail = (reason: string, extra: Record<string, string> = {}) => {
    throw new FeePayerValidationError(reason, { ...details, ...extra })
  }

  if (transactionChainId !== chainId)
    fail('fee-sponsored transaction chainId does not match challenge', {
      chainId: String(transactionChainId),
    })

  if (gas === undefined || gas <= 0n) fail('fee-sponsored transaction must declare gas')
  if (gas > policy.maxGas)
    fail('fee-sponsored transaction gas exceeds sponsor policy', {
      gas: gas.toString(),
    })

  if (maxFeePerGas === undefined || maxFeePerGas <= 0n)
    fail('fee-sponsored transaction must declare maxFeePerGas')
  if (maxFeePerGas > policy.maxFeePerGas)
    fail('fee-sponsored transaction maxFeePerGas exceeds sponsor policy', {
      maxFeePerGas: maxFeePerGas.toString(),
    })

  const maxTotalFee = gas * maxFeePerGas
  if (maxTotalFee > policy.maxTotalFee)
    fail('fee-sponsored transaction total fee budget exceeds sponsor policy', {
      gas: gas.toString(),
      maxFeePerGas: maxFeePerGas.toString(),
      totalFee: maxTotalFee.toString(),
    })

  if (maxPriorityFeePerGas !== undefined && maxPriorityFeePerGas > maxFeePerGas)
    fail('fee-sponsored transaction maxPriorityFeePerGas exceeds maxFeePerGas', {
      maxFeePerGas: maxFeePerGas.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    })
  if (maxPriorityFeePerGas !== undefined && maxPriorityFeePerGas > policy.maxPriorityFeePerGas)
    fail('fee-sponsored transaction maxPriorityFeePerGas exceeds sponsor policy', {
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    })

  if (nonceKey === undefined) fail('fee-sponsored transaction must use an expiring nonce')
  if (validBefore === undefined)
    fail('fee-sponsored transaction must declare validBefore for the expiring nonce')

  const nowSeconds = Math.floor(now.getTime() / 1_000)
  if (validBefore <= nowSeconds)
    fail('fee-sponsored transaction has already expired', {
      validBefore: String(validBefore),
    })

  const challengeExpirySeconds = challengeExpires
    ? Math.floor(new Date(challengeExpires).getTime() / 1_000)
    : undefined
  const maxValidBefore = Math.min(
    nowSeconds + policy.maxValidityWindowSeconds,
    challengeExpirySeconds ? challengeExpirySeconds + 60 : Number.MAX_SAFE_INTEGER,
  )
  if (validBefore > maxValidBefore)
    fail('fee-sponsored transaction validity window exceeds sponsor policy', {
      validBefore: String(validBefore),
    })

  if (feeToken !== undefined) {
    if (typeof feeToken !== 'string') fail('fee-sponsored transaction feeToken is invalid')
    if (expectedFeeToken && !TempoAddress_internal.isEqual(feeToken, expectedFeeToken))
      fail('fee-sponsored transaction feeToken is not allowed', {
        feeToken,
      })
  }

  return {
    accessList,
    account,
    calls,
    chainId: transactionChainId,
    feePayer: account,
    ...(feeToken ? { feeToken } : {}),
    ...(from ? { from } : {}),
    gas,
    ...(nonce !== undefined ? { nonce } : {}),
    maxFeePerGas,
    ...(maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas } : {}),
    nonceKey,
    ...(signature ? { signature } : {}),
    type: 'tempo' as const,
    ...(validAfter !== undefined ? { validAfter } : {}),
    validBefore,
  } satisfies ReturnType<(typeof Transaction)['deserialize']> & {
    account: Account
    feePayer: Account
  }
}

export class FeePayerValidationError extends Error {
  override readonly name = 'FeePayerValidationError'

  constructor(reason: string, details: Record<string, string>) {
    super(
      [
        `Invalid transaction: ${reason}`,
        ...Object.entries(details).map(([k, v]) => `  - ${k}: ${v}`),
      ].join('\n'),
    )
  }
}
