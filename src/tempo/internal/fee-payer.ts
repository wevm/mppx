import { Address, Secp256k1, Signature } from 'ox'
import { TempoAddress, TxEnvelopeTempo } from 'ox/tempo'
import type { Hex } from 'viem'
import type { Account, LocalAccount } from 'viem'
import { decodeFunctionData, encodeFunctionData, maxUint256, toFunctionSelector, toHex } from 'viem'
import { Abis, Addresses, Transaction } from 'viem/tempo'

import { escrowAbi as legacyEscrowAbi } from '../legacy/session/escrow.abi.js'
import { escrowAbi } from '../session/precompile/escrow.abi.js'
import * as TempoAddress_internal from './address.js'
import * as defaults from './defaults.js'
import { defaultFeeTokens } from './fee-token.js'
import { machineTokenSwapperAbi } from './machine-token-charge.js'
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

type HostedFeePayerFillResult = {
  tx?: {
    feePayerSignature?: unknown
    feeToken?: unknown
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

/** Returns fee tokens that mppx allows sponsored transactions to charge. */
export function defaultAllowedFeeTokens(chainId: number | undefined) {
  return defaultFeeTokens(chainId)
}

/** Validates the fee-token address and, when supplied, the server's allowlist. */
export function assertAllowedFeeToken(
  transaction: { feeToken?: unknown },
  allowedFeeTokens?: readonly TempoAddress.Address[] | undefined,
) {
  const { feeToken } = transaction
  if (feeToken === undefined) return
  if (
    typeof feeToken !== 'string' ||
    !(Address.validate(feeToken, { strict: false }) || TempoAddress.validate(feeToken))
  )
    throw new FeePayerValidationError('fee-sponsored transaction feeToken is invalid', {})
  const normalized = feeToken as TempoAddress.Address
  if (
    allowedFeeTokens &&
    !allowedFeeTokens.some((allowed) => TempoAddress_internal.isEqual(allowed, normalized))
  )
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
    ...(transaction.keyAuthorization !== undefined
      ? { keyAuthorization: transaction.keyAuthorization }
      : {}),
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
 * Co-signs a sender-signed partial sponsorship envelope through a hosted
 * fee-payer transport without letting the endpoint mutate sender-committed
 * transaction fields.
 *
 * @returns The serialized co-signed transaction plus the sponsor's recovered
 *   `feePayer` address and chosen `feeToken`, so callers can pre-broadcast
 *   simulate the exact transaction the sponsor broadcasts.
 */
export async function fillHostedFeePayerTransaction(parameters: {
  /** Optional merchant restriction on the hosted sponsor's token choice. */
  allowedFeeTokens?: readonly TempoAddress.Address[] | undefined
  challengeExpires?: string | undefined
  chainId: number
  details: Record<string, string>
  policy?: Partial<Policy> | undefined
  request: (args: {
    method: 'eth_fillTransaction'
    params: readonly [ReturnType<typeof hostedFeePayerRequest>]
  }) => Promise<unknown>
  transaction: SponsoredTransaction
}) {
  const { allowedFeeTokens, challengeExpires, chainId, details, policy, request, transaction } =
    parameters
  assertTransactionPolicy({
    challengeExpires,
    chainId,
    details,
    policy,
    transaction,
  })
  const result = (await request({
    method: 'eth_fillTransaction',
    params: [hostedFeePayerRequest(transaction)],
  })) as HostedFeePayerFillResult
  const filled = result?.tx
  if (!filled?.feePayerSignature)
    throw new FeePayerValidationError('hosted fee payer failed to sponsor transaction', {})
  if (typeof filled.feeToken !== 'string')
    throw new FeePayerValidationError('hosted fee payer did not return a feeToken', {})

  assertAllowedFeeToken({ feeToken: filled.feeToken }, allowedFeeTokens)

  const feePayerSignature = {
    ...(filled.feePayerSignature as { r: Hex; s: Hex }),
    yParity: Number((filled.feePayerSignature as { yParity?: unknown }).yParity),
  }
  const feeToken = filled.feeToken as TempoAddress.Address

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
    // `Signature.fromRpc` rejects a yParity of 0 that arrives without `v`.
    feePayerSignature: Signature.from({
      r: BigInt(feePayerSignature.r),
      s: BigInt(feePayerSignature.s),
      yParity: feePayerSignature.yParity,
    }),
    feeToken,
    serializedTransaction: await Transaction.serialize({
      ...transaction,
      feePayer: true,
      feePayerSignature,
      feeToken,
    } as never),
  }
}

/**
 * Returns a transaction shape suitable for pre-broadcast simulation.
 *
 * Sponsored transactions are first simulated as calls from the sender, without
 * signatures, fee payer or fee token, and with zero fee fields: Tempo nodes
 * (v1.18+) skip the fee-token balance check for a zero-fee `eth_call`, so the
 * sender's fee balance is irrelevant. The call keeps the transaction's exact
 * gas limit and the fields that set its intrinsic gas (nonce, nonce key,
 * validity window, key authorization, signature type), so it is the gas-bounded
 * check at the broadcast limit: a transaction whose gas is too low fails here
 * with out of gas instead of reverting onchain at the sponsor's expense.
 * Transferred value and call-level balances are still checked by the RPC.
 */
export function simulationTransaction(
  transaction: SponsoredTransaction,
  options: { feePayer: boolean },
) {
  if (options.feePayer) {
    const keyType = senderKeyType(transaction.signature)
    return {
      account: transaction.from,
      calls: transaction.calls,
      ...(transaction.accessList?.length ? { accessList: transaction.accessList } : {}),
      ...(transaction.gas !== undefined ? { gas: transaction.gas } : {}),
      ...(transaction.keyAuthorization !== undefined
        ? { keyAuthorization: transaction.keyAuthorization }
        : {}),
      ...(keyType ? { keyType } : {}),
      maxFeePerGas: 0n,
      maxPriorityFeePerGas: 0n,
      ...(transaction.nonce !== undefined ? { nonce: transaction.nonce } : {}),
      ...(transaction.nonceKey !== undefined ? { nonceKey: transaction.nonceKey } : {}),
      ...(transaction.validAfter !== undefined ? { validAfter: transaction.validAfter } : {}),
      ...(transaction.validBefore !== undefined ? { validBefore: transaction.validBefore } : {}),
    }
  }
  return {
    ...transaction,
    account: transaction.from,
    calls: transaction.calls,
    feePayerSignature: undefined,
  }
}

/** The key type hint for a sender signature whose verification costs more than secp256k1. */
function senderKeyType(signature: unknown): 'p256' | 'webAuthn' | undefined {
  const envelope = signature as { inner?: { type?: unknown }; type?: unknown } | undefined
  const type = envelope?.type === 'keychain' ? envelope.inner?.type : envelope?.type
  return type === 'p256' || type === 'webAuthn' ? type : undefined
}

/**
 * Returns the final fee-sponsored transaction shape for pre-broadcast
 * simulation.
 *
 * Tempo nodes recover the fee payer of an `eth_call` only from
 * `feePayerSignature`; a bare `feePayer` address is ignored and the sender is
 * billed instead. Pass the sponsor's signature so the node charges the fee
 * token to the sponsor, not to a sender that may not hold it. The sender's own
 * signature is never sent.
 */
export function sponsoredSimulationTransaction(
  transaction: SponsoredTransaction,
  options: {
    feePayer: TempoAddress.Address
    feePayerSignature?: Signature.Signature | undefined
    feeToken?: TempoAddress.Address | undefined
  },
) {
  const { feePayer, feePayerSignature, feeToken } = options
  return {
    ...transaction,
    account: transaction.from,
    calls: transaction.calls,
    feePayer,
    feePayerSignature: feePayerSignature ? Signature.toRpc(feePayerSignature) : undefined,
    ...(feeToken !== undefined ? { feeToken } : {}),
    signature: undefined,
  }
}

/** A completed sponsorship envelope that can be simulated before signing or broadcast. */
export type PreflightSponsorship = {
  feePayer: TempoAddress.Address
  /**
   * The sponsor's signature over the final envelope. Hosted sponsors return it
   * from `eth_fillTransaction`; local accounts are signed in `preflightSponsorship`.
   */
  feePayerSignature?: Signature.Signature | undefined
  feeToken?: TempoAddress.Address | undefined
  transaction: SponsoredTransaction
}

/**
 * Signs the fee-payer payload of a sponsored envelope with a local fee-payer
 * account, the same payload `Transaction.serialize` signs before broadcast.
 * Returns `undefined` when the envelope's fee payer cannot sign locally.
 */
export async function signFeePayerSimulation(
  transaction: SponsoredTransaction,
): Promise<Signature.Signature | undefined> {
  const {
    account: _account,
    feePayer,
    ...rest
  } = transaction as SponsoredTransaction & {
    account?: unknown
    feePayer?: unknown
  }
  if (typeof feePayer !== 'object' || feePayer === null) return undefined
  const sign = (feePayer as Partial<Pick<LocalAccount, 'sign'>>).sign
  if (typeof sign !== 'function' || !rest.from) return undefined
  const payload = TxEnvelopeTempo.getFeePayerSignPayload(
    TxEnvelopeTempo.from({
      ...rest,
      chainId: Number(rest.chainId),
      feePayerSignature: undefined,
      signature: undefined,
      type: 'tempo',
    } as never),
    { sender: rest.from as never },
  )
  return Signature.from(await sign({ hash: payload }))
}

/**
 * Runs the sender and final-envelope simulations around sponsorship.
 *
 * First, it simulates the sender's calls at the transaction's exact gas limit
 * with zero fee fields (see {@link simulationTransaction}). This is the
 * gas-bounded check at the broadcast limit, and needs no fee-token balance.
 * Next, `complete` resolves the sponsor and produces the co-signed transaction.
 * Finally, it simulates that transaction with its concrete fee payer, fee token
 * and fee payer signature, so the node bills the sponsor rather than the sender
 * and checks the sponsor's fee balance.
 *
 * A sponsored `eth_call` charges more gas than the mined transaction uses. A
 * local fee payer therefore signs a simulation-only copy whose gas is raised by
 * up to {@link sponsoredSimulationGasBuffer}, clamped so the copy stays within
 * the same fee payer `policy` (`maxGas`, `maxTotalFee`) as the real
 * transaction. The copy is never returned or broadcast. When the final
 * simulation runs without the full buffer (hosted signatures cover the client's
 * gas and cannot be padded, or the padding was clamped), a failure that is only
 * out of gas is tolerated, since the sender simulation already bounded gas at
 * the broadcast limit. Every other failure, such as an insufficient fee balance
 * or a revert, is rethrown.
 *
 * `complete` runs only after sender-context execution succeeds, so a reverting
 * transaction never reaches a local signer or hosted fee-payer.
 */
export async function preflightSponsorship<sponsorship extends PreflightSponsorship>(parameters: {
  complete: () => Promise<sponsorship>
  /** The fee payer policy the completed transaction was checked against. */
  policy?: Partial<Policy> | undefined
  simulate: (request: Record<string, unknown>) => Promise<unknown>
  transaction: SponsoredTransaction
}): Promise<sponsorship> {
  const { complete, policy, simulate, transaction } = parameters
  await simulate(simulationTransaction(transaction, { feePayer: true }))
  const completed = await complete()
  const { gas } = completed.transaction as { gas?: bigint | undefined }
  const simulated = await (async () => {
    if (completed.feePayerSignature)
      return { feePayerSignature: completed.feePayerSignature, transaction: completed.transaction }
    // The signature binds the gas limit, so a local fee payer signs a simulation-only copy
    // with headroom for the node's sponsored `eth_call` overhead. The broadcast keeps its gas.
    const padded =
      gas === undefined
        ? completed.transaction
        : {
            ...completed.transaction,
            gas: sponsoredSimulationGas(completed.transaction, policy),
          }
    const feePayerSignature = await signFeePayerSimulation(padded)
    return feePayerSignature
      ? { feePayerSignature, transaction: padded }
      : { feePayerSignature: undefined, transaction: completed.transaction }
  })()
  const simulatedGas = (simulated.transaction as { gas?: bigint | undefined }).gas
  try {
    await simulate(
      sponsoredSimulationTransaction(simulated.transaction, {
        feePayer: completed.feePayer,
        feePayerSignature: simulated.feePayerSignature,
        feeToken: completed.feeToken,
      }),
    )
  } catch (error) {
    const unpadded =
      gas !== undefined &&
      simulatedGas !== undefined &&
      simulatedGas < gas + sponsoredSimulationGasBuffer
    if (!unpadded || !isOutOfGasError(error)) throw error
  }
  return completed
}

/**
 * Returns the gas limit of a local fee payer's simulation-only copy: the
 * transaction's gas plus {@link sponsoredSimulationGasBuffer}, clamped to the
 * fee payer policy's `maxGas` and to `maxTotalFee / maxFeePerGas`, so the
 * signed copy never exceeds a cap the real transaction is held to.
 */
export function sponsoredSimulationGas(
  transaction: Pick<SponsoredTransaction, 'chainId' | 'gas' | 'maxFeePerGas'>,
  policyOverrides?: Partial<Policy> | undefined,
): bigint {
  const { chainId, gas, maxFeePerGas } = transaction
  if (gas === undefined)
    throw new FeePayerValidationError('fee-sponsored transaction must declare gas', {})
  const policy = getPolicy(Number(chainId), policyOverrides)
  let cap = policy.maxGas
  if (maxFeePerGas !== undefined && maxFeePerGas > 0n) {
    const feeCap = policy.maxTotalFee / maxFeePerGas
    if (feeCap < cap) cap = feeCap
  }
  if (gas > cap)
    throw new FeePayerValidationError('fee-sponsored transaction gas exceeds sponsor policy', {
      gas: gas.toString(),
    })
  const padded = gas + sponsoredSimulationGasBuffer
  return padded < cap ? padded : cap
}

/**
 * Returns true when a simulation failed only because it ran out of gas.
 *
 * Tempo nodes report out of gas as `out of gas: …` (code -32003, shared with
 * `insufficient fee token balance`) or `intrinsic gas too low` (code -32000),
 * so this matches the node's message anywhere in the error's cause chain rather
 * than the code.
 */
export function isOutOfGasError(error: unknown): boolean {
  const pattern = /out of gas|intrinsic gas too low/i
  for (let current = error, depth = 0; current && depth < 10; depth++) {
    const { cause, details, message } = current as {
      cause?: unknown
      details?: unknown
      message?: unknown
    }
    if (typeof details === 'string' && pattern.test(details)) return true
    if (typeof message === 'string' && pattern.test(message)) return true
    current = cause
  }
  return false
}

/**
 * Extra gas a local fee payer signs into its simulation-only envelope. Tempo's sponsored
 * `eth_call` charges more gas than the same transaction uses when mined (about 6,000 for a
 * session top-up on v1.18.1), so simulating at the signed limit would reject transactions
 * that succeed onchain. The padding is clamped to the fee payer policy; hosted signatures
 * cover the client's gas and are simulated as signed. In both cases the gas bound at the
 * broadcast limit comes from the sender simulation.
 */
export const sponsoredSimulationGasBuffer = 10_000n

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

const sponsoredCallAbi = [
  ...Abis.tip20,
  ...Abis.stablecoinDex,
  ...machineTokenSwapperAbi,
  ...legacyEscrowAbi,
  ...escrowAbi,
] as const
const sponsoredCallSelectors = new Set([
  Selectors.approve,
  Selectors.transfer,
  Selectors.transferWithMemo,
  Selectors.swapExactAmountOut,
  ...machineTokenSwapperAbi.map((item) => toFunctionSelector(item)),
  ...[...legacyEscrowAbi, ...escrowAbi]
    .filter((item) => item.type === 'function' && item.stateMutability === 'nonpayable')
    .map((item) => toFunctionSelector(item)),
])

function canonicalSponsoredCallData(
  data: Hex,
  call: string,
  fail: (reason: string, extra?: Record<string, string>) => never,
) {
  if (!sponsoredCallSelectors.has(data.slice(0, 10) as Hex))
    fail('fee-sponsored transaction call calldata is invalid', { call })

  let decoded: ReturnType<typeof decodeFunctionData<typeof sponsoredCallAbi>>
  try {
    decoded = decodeFunctionData({ abi: sponsoredCallAbi, data })
  } catch {
    fail('fee-sponsored transaction call calldata is invalid', { call })
  }
  return encodeFunctionData({
    abi: sponsoredCallAbi,
    functionName: decoded.functionName,
    args: decoded.args,
  })
}

/**
 * Rejects sponsored transaction fields that increase intrinsic gas without
 * changing the decoded payment intent.
 */
function assertCanonicalSponsoredTransaction(
  transaction: SponsoredTransaction,
  fail: (reason: string, extra?: Record<string, string>) => never,
) {
  if (transaction.accessList !== undefined && transaction.accessList.length > 0)
    fail('fee-sponsored transaction accessList is not allowed', {
      accessListEntries: String(transaction.accessList.length),
    })

  const calls = transaction.calls
  if (!Array.isArray(calls) || calls.length === 0)
    fail('fee-sponsored transaction must declare calls')

  for (const [index, call] of calls.entries()) {
    const callIndex = String(index)
    const value = call.value
    if (value !== undefined && value !== 0n)
      fail('fee-sponsored transaction call value is not allowed', {
        call: callIndex,
        value: value.toString(),
      })

    const data = call.data
    if (!data)
      fail('fee-sponsored transaction call is missing calldata', {
        call: callIndex,
      })

    const canonical = canonicalSponsoredCallData(data, callIndex, fail)
    if (data.toLowerCase() !== canonical.toLowerCase())
      fail('fee-sponsored transaction call calldata is not canonical', {
        call: callIndex,
      })
  }
}

/**
 * Validates an allowed fee-payer pattern. Returns the funding currency when the
 * calls are bound to the expected payment transfers.
 */
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
    if (amountOut <= 0n || amountOut > expectedAmountOut)
      throw new FeePayerValidationError(
        'swap output must be positive and no greater than payment amount',
        details,
      )
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
  return approveCall?.to ?? currency
}

/** Rejects transactions that can expire before sponsorship and submission finish. */
export function assertRemainingValidity(parameters: {
  details?: Record<string, string> | undefined
  now?: Date | undefined
  transaction: { validBefore?: number | undefined }
}) {
  const { details = {}, now = new Date(), transaction } = parameters
  const { validBefore } = transaction
  const fail = (reason: string): never => {
    throw new FeePayerValidationError(reason, { ...details, validBefore: String(validBefore) })
  }
  if (validBefore === undefined)
    return fail('fee-sponsored transaction must declare validBefore for the expiring nonce')
  if (validBefore <= Math.floor(now.getTime() / 1_000))
    fail('fee-sponsored transaction has already expired')
  if (validBefore < Math.ceil(now.getTime() / 1_000) + defaults.minRemainingValiditySeconds)
    fail(
      `fee-sponsored transaction needs at least ${defaults.minRemainingValiditySeconds} seconds of remaining validity`,
    )
}

/** Validates sponsor fee policy limits for a fee-payer transaction. */
export function assertTransactionPolicy(parameters: {
  challengeExpires?: string | undefined
  chainId: number
  details: Record<string, string>
  now?: Date | undefined
  policy?: Partial<Policy> | undefined
  transaction: SponsoredTransaction
}) {
  const {
    challengeExpires,
    chainId,
    details,
    now = new Date(),
    policy: policyOverrides,
    transaction,
  } = parameters
  const policy = getPolicy(chainId, policyOverrides)
  const {
    chainId: transactionChainId,
    gas,
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonceKey,
    validBefore,
  } = transaction

  const fail = (reason: string, extra: Record<string, string> = {}) => {
    throw new FeePayerValidationError(reason, { ...details, ...extra })
  }

  if (transaction.type !== undefined && transaction.type !== 'tempo')
    fail('fee-sponsored transaction type is invalid', {
      type: String(transaction.type),
    })

  if (transactionChainId !== chainId)
    fail('fee-sponsored transaction chainId does not match challenge', {
      chainId: String(transactionChainId),
    })

  assertCanonicalSponsoredTransaction(transaction, fail)

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

  const maxTotalFee = BigInt(gasLimit) * BigInt(maxFeePerGasValue)
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

  if (!Number.isInteger(policy.maxValidityWindowSeconds) || policy.maxValidityWindowSeconds < 15)
    fail('sponsor maxValidityWindowSeconds must be an integer of at least 15 seconds')
  assertRemainingValidity({ transaction, details, now })

  const challengeExpirySeconds = challengeExpires
    ? Math.floor(new Date(challengeExpires).getTime() / 1_000)
    : undefined
  const maxValidBefore = Math.min(
    Math.ceil(now.getTime() / 1_000) + policy.maxValidityWindowSeconds,
    challengeExpirySeconds ? challengeExpirySeconds + 60 : Number.MAX_SAFE_INTEGER,
  )
  if (validBeforeValue > maxValidBefore)
    fail('fee-sponsored transaction validity window exceeds sponsor policy', {
      validBefore: String(validBeforeValue),
    })

  return {
    gasLimit,
    maxFeePerGasValue,
    totalFee: maxTotalFee,
    validBeforeValue,
  }
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
  const transactionRecord = transaction as Record<string, unknown>

  const {
    accessList,
    calls,
    chainId: transactionChainId,
    feeToken,
    from,
    keyAuthorization,
    maxPriorityFeePerGas,
    nonce,
    nonceKey,
    signature,
    validAfter,
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

  const { gasLimit, maxFeePerGasValue, validBeforeValue } = assertTransactionPolicy({
    challengeExpires,
    chainId,
    details,
    now,
    policy: policyOverrides,
    transaction,
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
    ...(keyAuthorization !== undefined ? { keyAuthorization } : {}),
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
