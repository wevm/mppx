import type { TempoAddress } from 'ox/tempo'
import { TxEnvelopeTempo } from 'ox/tempo'
import { decodeFunctionData } from 'viem'
import { Abis, Addresses } from 'viem/tempo'

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

/** Validates that a set of transaction calls matches an allowed fee-payer pattern. */
export function validateCalls(
  calls: readonly { data?: `0x${string}` | undefined; to?: TempoAddress.Address | undefined }[],
  details: Record<string, string>,
) {
  const callSelectors = calls.map((c) => c.data?.slice(0, 10))
  const allowed = callScopes.some(
    (pattern) =>
      pattern.length === callSelectors.length &&
      pattern.every((sel, i) => sel === callSelectors[i]),
  )
  if (!allowed)
    throw new FeePayerValidationError('disallowed call pattern in fee-payer transaction', details)

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
