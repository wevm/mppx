import { Secp256k1 } from 'ox'
import type { TempoAddress } from 'ox/tempo'
import { TxEnvelopeTempo } from 'ox/tempo'
import type { Hex } from 'viem'
import type { Account } from 'viem'
import { decodeFunctionData, maxUint256, toHex } from 'viem'
import { Abis, Addresses, Transaction } from 'viem/tempo'

import * as TempoAddress_internal from './address.js'
import * as defaults from './defaults.js'
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

export type Policy = {
  maxGas: bigint
  maxFeePerGas: bigint
  maxPriorityFeePerGas: bigint
  maxTotalFee: bigint
  maxValidityWindowSeconds: number
}

// Reuse the exact object shape returned by `Transaction.deserialize()`.
// `typeof Transaction` gets the module value type, `['deserialize']` picks the
// deserialize function off that module, and `ReturnType<...>` asks TypeScript
// for that function's return type so this helper stays aligned with upstream
// Tempo transaction fields.
type SponsoredTransaction = ReturnType<(typeof Transaction)['deserialize']>

type HostedFeePayerFillResponse = {
  error?: { message?: string | undefined } | undefined
  result?: {
    tx?: {
      feePayerSignature?: unknown
      feeToken?: unknown
    }
  }
}

type ExpectedTransfer = {
  amount: string
  allowAnyMemo?: boolean | undefined
  memo?: Hex | undefined
  recipient: TempoAddress.Address
}

const preservedTransactionKeys = [
  'accessList',
  'calls',
  'chainId',
  'feeToken',
  'from',
  'gas',
  'keyAuthorization',
  'maxFeePerGas',
  'maxPriorityFeePerGas',
  'nonce',
  'nonceKey',
  'signature',
  'validAfter',
  'validBefore',
] as const satisfies readonly (keyof SponsoredTransaction)[]

const rejectedTransactionKeys = [
  'blobVersionedHashes',
  'blobs',
  'data',
  'feePayerSignature',
  'gasPrice',
  'kzg',
  'maxFeePerBlobGas',
  'r',
  's',
  'sidecars',
  'to',
  'v',
  'value',
  'yParity',
] as const

const rewrittenTransactionKeys = ['type'] as const

const supportedTransactionKeys = new Set<string>([
  ...preservedTransactionKeys,
  ...rejectedTransactionKeys,
  ...rewrittenTransactionKeys,
])

function pushAllowedFeeToken(tokens: TempoAddress.Address[], token: string | undefined) {
  if (!token) return
  const normalized = token as TempoAddress.Address
  if (tokens.some((existing) => TempoAddress_internal.isEqual(existing, normalized))) return
  tokens.push(normalized)
}

/** Returns fee tokens that mppx allows sponsored transactions to charge. */
export function defaultAllowedFeeTokens(chainId: number | undefined) {
  const tokens: TempoAddress.Address[] = []
  pushAllowedFeeToken(tokens, defaults.tokens.pathUsd)
  pushAllowedFeeToken(tokens, defaults.currency[chainId as keyof typeof defaults.currency])
  return tokens
}

/** Rejects a sponsored fee token outside the server's allowlist. */
export function assertAllowedFeeToken(
  transaction: { feeToken?: unknown },
  allowedFeeTokens: readonly TempoAddress.Address[],
) {
  const { feeToken } = transaction
  if (feeToken === undefined) return
  if (typeof feeToken !== 'string')
    throw new FeePayerValidationError('fee-sponsored transaction feeToken is invalid', {})
  const normalized = feeToken as TempoAddress.Address
  if (!allowedFeeTokens.some((allowed) => TempoAddress_internal.isEqual(allowed, normalized)))
    throw new FeePayerValidationError('fee-sponsored transaction feeToken is not allowed', {
      feeToken,
    })
}

function hostedFeePayerRequest(transaction: SponsoredTransaction) {
  return {
    ...(transaction.accessList?.length ? { accessList: transaction.accessList } : {}),
    calls: transaction.calls.map(
      (call: {
        data?: `0x${string}` | undefined
        to?: TempoAddress.Address | undefined
        value?: bigint | undefined
      }) => ({
        ...(call.to ? { to: call.to } : {}),
        ...(call.data ? { data: call.data } : {}),
        value: call.value === undefined ? '0x' : toHex(call.value),
      }),
    ),
    feePayer: true,
    from: transaction.from,
    ...(transaction.gas !== undefined ? { gas: toHex(transaction.gas) } : {}),
    ...(transaction.maxFeePerGas !== undefined
      ? { maxFeePerGas: toHex(transaction.maxFeePerGas) }
      : {}),
    ...(transaction.maxPriorityFeePerGas !== undefined
      ? { maxPriorityFeePerGas: toHex(transaction.maxPriorityFeePerGas) }
      : {}),
    nonce: toHex(transaction.nonce ?? 0),
    ...(transaction.nonceKey !== undefined ? { nonceKey: toHex(transaction.nonceKey) } : {}),
    type: '0x76',
    ...(transaction.validAfter !== undefined ? { validAfter: toHex(transaction.validAfter) } : {}),
    ...(transaction.validBefore !== undefined
      ? { validBefore: toHex(transaction.validBefore) }
      : {}),
  }
}

/**
 * Co-signs a sender-signed partial sponsorship envelope using a hosted
 * fee-payer endpoint without letting the endpoint mutate sender-committed
 * transaction fields.
 *
 * @returns The serialized co-signed transaction plus the sponsor's recovered
 *   `feePayer` address and chosen `feeToken`, so callers can pre-broadcast
 *   simulate the exact transaction the sponsor broadcasts.
 */
export async function fillHostedFeePayerTransaction(parameters: {
  allowedFeeTokens: readonly TempoAddress.Address[]
  transaction: SponsoredTransaction
  url: string
}) {
  const { allowedFeeTokens, transaction, url } = parameters
  assertNoKeyAuthorization(transaction)
  const response = await fetch(url, {
    body: JSON.stringify(
      {
        id: 1,
        jsonrpc: '2.0',
        method: 'eth_fillTransaction',
        params: [hostedFeePayerRequest(transaction)],
      },
      (_key, value) => (typeof value === 'bigint' ? toHex(value) : value),
    ),
    headers: { 'content-type': 'application/json' },
    method: 'POST',
  })
  const payload = (await response.json().catch(async () => ({
    error: { message: await response.text() },
  }))) as HostedFeePayerFillResponse
  const filled = payload.result?.tx
  if (!response.ok || payload.error || !filled?.feePayerSignature)
    throw new FeePayerValidationError(
      payload.error?.message ?? 'hosted fee payer failed to sponsor transaction',
      {},
    )
  if (typeof filled.feeToken !== 'string')
    throw new FeePayerValidationError('hosted fee payer did not return a feeToken', {})

  assertAllowedFeeToken({ feeToken: filled.feeToken }, allowedFeeTokens)

  const feePayerSignature = filled.feePayerSignature
  const feeToken = filled.feeToken

  // Recover the concrete sponsor address so the simulation can use a concrete
  // `feePayer` (the node rejects `eth_call` with `feePayer: true`).
  const feePayer = (() => {
    try {
      return Secp256k1.recoverAddress({
        payload: TxEnvelopeTempo.getFeePayerSignPayload(
          TxEnvelopeTempo.from({
            ...transaction,
            feePayerSignature: undefined,
            feeToken,
            signature: undefined,
          } as never),
          { sender: transaction.from as never },
        ),
        signature: feePayerSignature as never,
      })
    } catch {
      throw new FeePayerValidationError(
        'hosted fee payer returned an invalid feePayerSignature',
        {},
      )
    }
  })()

  return {
    feePayer,
    feeToken,
    serializedTransaction: await Transaction.serialize({
      ...transaction,
      feePayer: true,
      feePayerSignature,
      feeToken,
    } as never),
  }
}

/** Returns a transaction shape suitable for pre-broadcast simulation. */
export function simulationTransaction(
  transaction: SponsoredTransaction,
  options: { feePayer: boolean },
) {
  if (options.feePayer)
    return {
      account: transaction.from,
      calls: transaction.calls,
    }
  return {
    ...transaction,
    account: transaction.from,
    calls: transaction.calls,
    feePayerSignature: undefined,
  }
}

/**
 * maxTotalFee must be high enough to cover `transferWithMemo` and
 * swap transactions at peak gas prices. Bumped from 0.01 ETH in #327.
 */
const defaultPolicy: Policy = {
  maxGas: 2_000_000n,
  maxFeePerGas: 100_000_000_000n,
  maxPriorityFeePerGas: 10_000_000_000n,
  maxTotalFee: 50_000_000_000_000_000n,
  maxValidityWindowSeconds: 15 * 60,
}

const policyByChainId = {
  [defaults.chainId.mainnet]: defaultPolicy,
  // Moderato regularly needs a higher priority fee than mainnet.
  [defaults.chainId.testnet]: {
    ...defaultPolicy,
    maxPriorityFeePerGas: 50_000_000_000n,
  },
} as const satisfies Record<defaults.ChainId, Policy>

function getPolicy(chainId: number, overrides: Partial<Policy> | undefined): Policy {
  const base = policyByChainId[chainId as defaults.ChainId] ?? defaultPolicy
  if (!overrides) return base

  return {
    maxGas: overrides.maxGas ?? base.maxGas,
    maxFeePerGas: overrides.maxFeePerGas ?? base.maxFeePerGas,
    maxPriorityFeePerGas: overrides.maxPriorityFeePerGas ?? base.maxPriorityFeePerGas,
    maxTotalFee: overrides.maxTotalFee ?? base.maxTotalFee,
    maxValidityWindowSeconds: overrides.maxValidityWindowSeconds ?? base.maxValidityWindowSeconds,
  }
}

function isExpiringNonceKey(nonceKey: SponsoredTransaction['nonceKey']): boolean {
  return nonceKey === 'expiring' || nonceKey === maxUint256
}

/** Validates that a set of transaction calls matches an allowed fee-payer pattern. */
export function validateCalls(
  calls: readonly { data?: `0x${string}` | undefined; to?: TempoAddress.Address | undefined }[],
  details: Record<string, string>,
  options?: {
    currency?: TempoAddress.Address | undefined
    expectedTransfers?: readonly ExpectedTransfer[] | undefined
  },
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
  if (transferSelectors.length === 0)
    throw new FeePayerValidationError('disallowed call pattern in fee-payer transaction', details)

  const expectedTransfers = options?.expectedTransfers
  const transferLimit = expectedTransfers?.length ?? 11
  if (
    transferSelectors.length > transferLimit ||
    transferSelectors.some(
      (selector) => selector !== Selectors.transfer && selector !== Selectors.transferWithMemo,
    ) ||
    (expectedTransfers && transferSelectors.length !== expectedTransfers.length)
  )
    throw new FeePayerValidationError('disallowed call pattern in fee-payer transaction', details)

  // Bind the swap approval to the token the DEX call will actually spend.
  const buyCall = calls.find((c) => c.data?.slice(0, 10) === Selectors.swapExactAmountOut)
  const buyArgs = buyCall
    ? (decodeFunctionData({ abi: Abis.stablecoinDex, data: buyCall.data! }).args as [
        `0x${string}`,
        `0x${string}`,
        bigint,
        bigint,
      ])
    : undefined

  const approveCall = calls.find((c) => c.data?.slice(0, 10) === Selectors.approve)
  if (approveCall) {
    const { args } = decodeFunctionData({ abi: Abis.tip20, data: approveCall.data! })
    const [spender, amount] = args as [`0x${string}`, bigint]
    if (!approveCall.to || (buyArgs && !TempoAddress_internal.isEqual(approveCall.to, buyArgs[0])))
      throw new FeePayerValidationError('approve target does not match swap tokenIn', details)
    if (!TempoAddress_internal.isEqual(spender, Addresses.stablecoinDex))
      throw new FeePayerValidationError('approve spender is not the DEX', details)
    if (buyArgs && amount !== buyArgs[3])
      throw new FeePayerValidationError('approve amount does not match swap max input', details)
  }
  if (
    buyCall &&
    (!buyCall.to || !TempoAddress_internal.isEqual(buyCall.to, Addresses.stablecoinDex))
  )
    throw new FeePayerValidationError('buy target is not the DEX', details)

  if (!expectedTransfers) return

  const currency = options?.currency ?? (details.currency as TempoAddress.Address | undefined)
  if (!currency) throw new FeePayerValidationError('missing payment currency', details)

  if (buyArgs) {
    const [, tokenOut, amountOut] = buyArgs
    const expectedAmountOut = expectedTransfers.reduce(
      (sum, transfer) => sum + BigInt(transfer.amount),
      0n,
    )
    if (!TempoAddress_internal.isEqual(tokenOut, currency))
      throw new FeePayerValidationError('swap tokenOut does not match payment currency', details)
    if (amountOut !== expectedAmountOut)
      throw new FeePayerValidationError('swap output does not match payment amount', details)
  }

  const transferCalls = calls.slice(hasSwapPrefix ? 2 : 0)
  const sorted = [...expectedTransfers].sort((a, b) => {
    if (a.memo && !b.memo) return -1
    if (!a.memo && b.memo) return 1
    return 0
  })

  const used = new Set<number>()
  for (const expected of sorted) {
    const matchIndex = transferCalls.findIndex((call, index) => {
      if (used.has(index)) return false
      if (!call.to || !TempoAddress_internal.isEqual(call.to, currency) || !call.data) return false

      try {
        const selector = call.data.slice(0, 10)
        const { args } = decodeFunctionData({ abi: Abis.tip20, data: call.data })
        if (selector === Selectors.transfer) {
          const [recipient, amount] = args as [`0x${string}`, bigint]
          if (!TempoAddress_internal.isEqual(recipient, expected.recipient)) return false
          if (amount.toString() !== expected.amount) return false
          return expected.memo === undefined
        }

        if (selector === Selectors.transferWithMemo) {
          const [recipient, amount, memo] = args as [`0x${string}`, bigint, Hex]
          if (!TempoAddress_internal.isEqual(recipient, expected.recipient)) return false
          if (amount.toString() !== expected.amount) return false
          if (expected.memo) return memo.toLowerCase() === expected.memo.toLowerCase()
          return expected.allowAnyMemo === true
        }
      } catch {
        return false
      }

      return false
    })

    if (matchIndex === -1)
      throw new FeePayerValidationError('payment transfer does not match challenge', details)

    used.add(matchIndex)
  }
}

/** Rejects account key authorization payloads on fee-sponsored transactions. */
export function assertNoKeyAuthorization(transaction: { keyAuthorization?: unknown }) {
  if (transaction.keyAuthorization !== undefined)
    throw new FeePayerValidationError(
      'fee-sponsored transaction must not include keyAuthorization',
      {},
    )
}

export function prepareSponsoredTransaction(parameters: {
  account: Account
  allowedFeeTokens?: readonly TempoAddress.Address[] | undefined
  challengeExpires?: string | undefined
  chainId: number
  details: Record<string, string>
  now?: Date | undefined
  policy?: Partial<Policy> | undefined
  transaction: SponsoredTransaction
}) {
  const {
    account,
    allowedFeeTokens,
    challengeExpires,
    chainId,
    details,
    now = new Date(),
    policy: policyOverrides,
    transaction,
  } = parameters
  const policy = getPolicy(chainId, policyOverrides)
  const transactionRecord = transaction as Record<string, unknown>

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

  const unsupportedKeys = Object.entries(transaction).flatMap(([key, value]) => {
    if (value === undefined) return []
    if (supportedTransactionKeys.has(key)) return []
    return [key]
  })
  if (unsupportedKeys.length > 0)
    fail('fee-sponsored transaction contains unsupported fields', {
      unsupportedFields: unsupportedKeys.join(', '),
    })

  const rejectedKeys = rejectedTransactionKeys.filter((key) => {
    const value = transactionRecord[key]
    return value !== undefined && value !== null
  })
  if (rejectedKeys.length > 0)
    fail('fee-sponsored transaction contains rejected fields', {
      rejectedFields: rejectedKeys.join(', '),
    })

  assertNoKeyAuthorization(transaction)

  if (transaction.type !== undefined && transaction.type !== 'tempo')
    fail('fee-sponsored transaction type is invalid', {
      type: String(transaction.type),
    })

  if (transactionChainId !== chainId)
    fail('fee-sponsored transaction chainId does not match challenge', {
      chainId: String(transactionChainId),
    })

  if (gas === undefined || gas <= 0n) fail('fee-sponsored transaction must declare gas')
  const gasLimit = gas
  if (gasLimit > policy.maxGas)
    fail('fee-sponsored transaction gas exceeds sponsor policy', {
      gas: gasLimit.toString(),
    })

  if (maxFeePerGas === undefined || maxFeePerGas <= 0n)
    fail('fee-sponsored transaction must declare maxFeePerGas')
  const maxFeePerGasValue = maxFeePerGas
  if (maxFeePerGasValue > policy.maxFeePerGas)
    fail('fee-sponsored transaction maxFeePerGas exceeds sponsor policy', {
      maxFeePerGas: maxFeePerGasValue.toString(),
    })

  const maxTotalFee = gasLimit * maxFeePerGasValue
  if (maxTotalFee > policy.maxTotalFee)
    fail('fee-sponsored transaction total fee budget exceeds sponsor policy', {
      gas: gasLimit.toString(),
      maxFeePerGas: maxFeePerGasValue.toString(),
      totalFee: maxTotalFee.toString(),
    })

  if (maxPriorityFeePerGas !== undefined && maxPriorityFeePerGas > maxFeePerGasValue)
    fail('fee-sponsored transaction maxPriorityFeePerGas exceeds maxFeePerGas', {
      maxFeePerGas: maxFeePerGasValue.toString(),
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    })
  if (maxPriorityFeePerGas !== undefined && maxPriorityFeePerGas > policy.maxPriorityFeePerGas)
    fail('fee-sponsored transaction maxPriorityFeePerGas exceeds sponsor policy', {
      maxPriorityFeePerGas: maxPriorityFeePerGas.toString(),
    })

  if (!isExpiringNonceKey(nonceKey)) fail('fee-sponsored transaction must use an expiring nonce')
  if (validBefore === undefined)
    fail('fee-sponsored transaction must declare validBefore for the expiring nonce')
  const validBeforeValue = validBefore

  const nowSeconds = Math.floor(now.getTime() / 1_000)
  if (validBeforeValue <= nowSeconds)
    fail('fee-sponsored transaction has already expired', {
      validBefore: String(validBeforeValue),
    })

  const challengeExpirySeconds = challengeExpires
    ? Math.floor(new Date(challengeExpires).getTime() / 1_000)
    : undefined
  const maxValidBefore = Math.min(
    nowSeconds + policy.maxValidityWindowSeconds,
    challengeExpirySeconds ? challengeExpirySeconds + 60 : Number.MAX_SAFE_INTEGER,
  )
  if (validBeforeValue > maxValidBefore)
    fail('fee-sponsored transaction validity window exceeds sponsor policy', {
      validBefore: String(validBeforeValue),
    })

  const normalizedFeeToken = (() => {
    if (feeToken === undefined) return undefined
    if (typeof feeToken !== 'string') fail('fee-sponsored transaction feeToken is invalid')
    return feeToken
  })()

  if (normalizedFeeToken !== undefined) {
    if (
      allowedFeeTokens &&
      !allowedFeeTokens.some((allowed) =>
        TempoAddress_internal.isEqual(normalizedFeeToken, allowed),
      )
    )
      fail('fee-sponsored transaction feeToken is not allowed', {
        feeToken: normalizedFeeToken,
      })
  }

  return {
    accessList,
    account,
    calls,
    chainId: transactionChainId,
    feePayer: account,
    ...(normalizedFeeToken ? { feeToken: normalizedFeeToken } : {}),
    ...(from ? { from } : {}),
    gas: gasLimit,
    ...(nonce !== undefined ? { nonce } : {}),
    maxFeePerGas: maxFeePerGasValue,
    ...(maxPriorityFeePerGas !== undefined ? { maxPriorityFeePerGas } : {}),
    nonceKey,
    ...(signature ? { signature } : {}),
    type: 'tempo' as const,
    ...(validAfter !== undefined ? { validAfter } : {}),
    validBefore: validBeforeValue,
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
