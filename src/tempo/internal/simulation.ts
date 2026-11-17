import { decodeErrorResult, type Address } from 'viem'
import { Abis } from 'viem/tempo'

import * as Errors from '../../Errors.js'

const abi = [
  ...Abis.accountKeychain.filter((item) => item.type === 'error'),
  ...Abis.tip20.filter((item) => item.type === 'error'),
]

/**
 * Returns the revert data of a failed simulation (`eth_estimateGas` or `eth_call`), found anywhere
 * in the error's `cause` chain.
 */
export function getRevertData(error: unknown): `0x${string}` | undefined {
  const seen = new Set<unknown>()
  let current = error
  while (typeof current === 'object' && current !== null && !seen.has(current)) {
    seen.add(current)
    const data = (current as { data?: unknown }).data
    if (isRevertData(data)) return data
    const nested = (data as { data?: unknown } | undefined)?.data
    if (isRevertData(nested)) return nested
    current = (current as { cause?: unknown }).cause
  }
  return undefined
}

/**
 * Maps a failed pre-signing simulation to a typed client error.
 *
 * Tempo reverts with `SpendingLimitExceeded()` when the signing access key's remaining limit is
 * below the payment, and with `InsufficientBalance(available, required, token)` when the account
 * holds too little of a token. Both would fail on chain, and a fee payer would pay for the failed
 * transaction, so the client stops before it signs. Returns `undefined` for any other error.
 */
export function toClientError(
  error: unknown,
  parameters: { account: { address: Address; accessKeyAddress?: unknown } },
): Errors.SpendingLimitExceededError | Errors.InsufficientBalanceError | undefined {
  const data = getRevertData(error)
  if (!data) return undefined
  const decoded = (() => {
    try {
      return decodeErrorResult({ abi, data })
    } catch {
      return undefined
    }
  })()
  if (decoded?.errorName === 'SpendingLimitExceeded') {
    const accessKey = parameters.account.accessKeyAddress
    return new Errors.SpendingLimitExceededError({
      accessKey: typeof accessKey === 'string' ? (accessKey as Address) : undefined,
      account: parameters.account.address,
      cause: error,
    })
  }
  if (decoded?.errorName === 'InsufficientBalance') {
    const [available, required, token] = decoded.args as readonly [bigint, bigint, Address]
    return new Errors.InsufficientBalanceError({
      cause: error,
      reason: `${parameters.account.address} holds ${available} of token ${token}, but the payment requires ${required}`,
    })
  }
  return undefined
}

/**
 * Runs a step that simulates the transaction before it is signed, such as
 * `prepareTransactionRequest` (which estimates gas), and rethrows a spending-limit or balance
 * revert as a typed client error.
 */
export async function run<value>(
  parameters: { account: { address: Address; accessKeyAddress?: unknown } },
  fn: () => Promise<value>,
): Promise<value> {
  try {
    return await fn()
  } catch (error) {
    throw toClientError(error, parameters) ?? error
  }
}

function isRevertData(value: unknown): value is `0x${string}` {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{8}/.test(value)
}
