import {
  isAddress,
  isAddressEqual,
  zeroAddress,
  type Account as viem_Account,
  type Address,
  type Hex,
} from 'viem'

import type * as Challenge from '../../../Challenge.js'
import {
  AmountExceedsDepositError,
  ChannelClosedError,
  ChannelNotFoundError,
  DeltaTooSmallError,
  InsufficientBalanceError,
  InvalidSignatureError,
  VerificationFailedError,
} from '../../../Errors.js'
import type * as FeePayer from '../../internal/fee-payer.js'
import * as Chain from '../precompile/Chain.js'
import { readChannelClosedReceiptFields } from '../precompile/Chain.js'
import * as Channel from '../precompile/Channel.js'
import {
  createSessionReceipt,
  uint96,
  type ChannelDescriptor,
  type SessionCredentialPayload,
  type SessionReceipt,
  type SignedVoucher,
} from '../precompile/Protocol.js'
import * as Voucher from '../precompile/Voucher.js'
import * as ChannelStore from './ChannelStore.js'
import { getChallengePaymentFields } from './RequestState.js'
import {
  assertSettlementSender,
  getClientAccount,
  reconcileConfirmedSettlementClaim,
  settleIfAvailable,
  type OnSessionSettlement,
} from './Settlement.js'

/** Returns the effective voucher signer for a TIP-1034 descriptor. */
export function authorizedSigner(descriptor: Channel.ChannelDescriptor): Address {
  return isAddressEqual(descriptor.authorizedSigner, zeroAddress)
    ? descriptor.payer
    : descriptor.authorizedSigner
}

/** Asserts that a credential payload includes a TIP-1034 descriptor. */
export function assertDescriptor(payload: {
  descriptor?: Channel.ChannelDescriptor | undefined
}): asserts payload is { descriptor: Channel.ChannelDescriptor } {
  if (!payload.descriptor)
    throw new VerificationFailedError({
      reason: 'descriptor required for TIP-1034 session action',
    })
}

/** Asserts that two TIP-1034 descriptors identify the same channel. */
export function assertSameDescriptor(a: Channel.ChannelDescriptor, b: Channel.ChannelDescriptor) {
  if (
    !isAddressEqual(a.payer, b.payer) ||
    !isAddressEqual(a.payee, b.payee) ||
    !isAddressEqual(a.operator, b.operator) ||
    !isAddressEqual(a.token, b.token) ||
    !isAddressEqual(a.authorizedSigner, b.authorizedSigner) ||
    a.salt.toLowerCase() !== b.salt.toLowerCase() ||
    a.expiringNonceHash.toLowerCase() !== b.expiringNonceHash.toLowerCase()
  )
    throw new VerificationFailedError({
      reason: 'credential descriptor does not match stored channel',
    })
}

/**
 * Validates a TIP-1034 descriptor against channel ID, server destination, and token.
 */
export function validateChannelDescriptor(
  descriptor: Channel.ChannelDescriptor,
  channelId: Address | `0x${string}`,
  chainId: number,
  escrow: Address,
  recipient: Address,
  currency: Address,
  expectedOperator?: Address | undefined,
): void {
  const computed = Channel.computeId({ ...descriptor, chainId, escrow })
  if (computed.toLowerCase() !== channelId.toLowerCase()) {
    throw new VerificationFailedError({ reason: 'channel descriptor does not match channelId' })
  }
  if (!isAddressEqual(descriptor.payee, recipient)) {
    throw new VerificationFailedError({
      reason: 'channel descriptor payee does not match server destination',
    })
  }
  if (!isAddressEqual(descriptor.token, currency)) {
    throw new VerificationFailedError({
      reason: 'channel descriptor token does not match server token',
    })
  }
  if (expectedOperator !== undefined && !isAddressEqual(descriptor.operator, expectedOperator)) {
    throw new VerificationFailedError({
      reason: 'channel descriptor operator does not match server operator',
    })
  }
}

/** Accepts the advertised fee token while preserving pre-advertisement direct clients. */
function allowedSponsoredFeeTokens(currency: Address, feeToken?: Address | undefined) {
  if (!feeToken || isAddressEqual(feeToken, currency)) return [currency]
  return [feeToken, currency]
}

/** Validates on-chain channel state before accepting or charging a credential. */
export function validateChannelState(state: Chain.ChannelState, amount?: bigint): void {
  if (state.deposit === 0n) {
    throw new ChannelNotFoundError({ reason: 'channel not funded on-chain' })
  }
  if (state.closeRequestedAt !== 0) {
    throw new ChannelClosedError({ reason: 'channel has a pending close request' })
  }
  if (amount !== undefined && state.deposit - state.settled < amount) {
    throw new InsufficientBalanceError({
      reason: 'channel available balance insufficient for requested amount',
    })
  }
}

/** Asserts that an opening channel covers the route's requested payment. */
export function assertOpenCredentialCoversRequest(parameters: {
  cumulativeAmount: bigint
  openDeposit: bigint
  requestAmount: bigint
}): void {
  const { cumulativeAmount, openDeposit, requestAmount } = parameters
  if (openDeposit < requestAmount)
    throw new VerificationFailedError({ reason: 'open deposit is less than request amount' })
  if (cumulativeAmount < requestAmount)
    throw new VerificationFailedError({ reason: 'voucher amount is less than request amount' })
}

/** Verifies that the credential source is authorized to spend from the channel. */
export function assertCredentialSourceCanSpend(parameters: {
  chainId: number
  channel: Pick<ChannelStore.State, 'authorizedSigner' | 'payer'>
  source?: string | undefined
}): void {
  const sourceAddress = readCredentialSourceAddress(parameters.source, parameters.chainId)
  if (
    isAddressEqual(sourceAddress, parameters.channel.payer) ||
    isAddressEqual(sourceAddress, parameters.channel.authorizedSigner)
  )
    return
  throw new VerificationFailedError({
    reason: 'credential source does not match channel payer or authorized signer',
  })
}

function readCredentialSourceAddress(source: string | undefined, chainId: number): Address {
  const prefix = `did:pkh:eip155:${chainId}:`
  if (!source?.startsWith(prefix))
    throw new VerificationFailedError({ reason: 'credential source does not match channel' })
  const address = source.slice(prefix.length)
  if (isAddress(address, { strict: false })) return address
  throw new VerificationFailedError({ reason: 'invalid credential source' })
}

const sessionCredentialActions = [
  'open',
  'topUp',
  'voucher',
  'close',
] as const satisfies readonly SessionCredentialPayload['action'][]
const sessionCredentialActionSet = new Set<string>(sessionCredentialActions)

/** Shared action and channel fields required on every session credential payload. */
export type SessionCredentialPayloadHeader = {
  /** Credential action discriminator. */
  action: SessionCredentialPayload['action']
  /** Channel ID the credential acts on. */
  channelId: Hex
}

type SessionCredentialPayloadData = {
  candidate: Record<string, unknown>
  header: SessionCredentialPayloadHeader
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

function isSessionCredentialAction(value: unknown): value is SessionCredentialPayload['action'] {
  return typeof value === 'string' && sessionCredentialActionSet.has(value)
}

function isHex(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value)
}

function isHash(value: unknown): value is Hex {
  return typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)
}

function readAddress(value: unknown, field: string): Address {
  if (typeof value === 'string' && isAddress(value, { strict: false })) return value
  throw new VerificationFailedError({ reason: `invalid session credential ${field}` })
}

function readHash(value: unknown, field: string): Hex {
  if (isHash(value)) return value
  throw new VerificationFailedError({ reason: `invalid session credential ${field}` })
}

function readHex(value: unknown, field: string): Hex {
  if (isHex(value)) return value
  throw new VerificationFailedError({ reason: `invalid session credential ${field}` })
}

function readRawAmount(value: unknown, field: string): string {
  if (typeof value === 'string' && /^[0-9]+$/.test(value)) return value
  throw new VerificationFailedError({ reason: `invalid session credential ${field}` })
}

function readPayloadObject(payload: unknown): Record<string, unknown> {
  if (!isObject(payload))
    throw new VerificationFailedError({ reason: 'invalid session credential payload' })
  return payload
}

function readDescriptor(value: unknown): ChannelDescriptor {
  if (value === undefined)
    throw new VerificationFailedError({
      reason: 'descriptor required for TIP-1034 session action',
    })
  const candidate = readPayloadObject(value)
  return {
    payer: readAddress(candidate.payer, 'descriptor.payer'),
    payee: readAddress(candidate.payee, 'descriptor.payee'),
    operator: readAddress(candidate.operator, 'descriptor.operator'),
    token: readAddress(candidate.token, 'descriptor.token'),
    salt: readHash(candidate.salt, 'descriptor.salt'),
    authorizedSigner: readAddress(candidate.authorizedSigner, 'descriptor.authorizedSigner'),
    expiringNonceHash: readHash(candidate.expiringNonceHash, 'descriptor.expiringNonceHash'),
  }
}

function readPayloadHeader(payload: unknown): SessionCredentialPayloadData {
  const candidate = readPayloadObject(payload)
  if (!isSessionCredentialAction(candidate.action)) {
    throw new VerificationFailedError({ reason: 'invalid session credential action' })
  }
  return {
    candidate,
    header: {
      action: candidate.action,
      channelId: ChannelStore.normalizeChannelId(readHash(candidate.channelId, 'channelId')),
    },
  }
}

/** Validates the action discriminator for a TIP-1034 session credential payload. */
export function requireSessionCredentialAction(
  payload: unknown,
): SessionCredentialPayload['action'] {
  const candidate = readPayloadObject(payload)
  if (!isSessionCredentialAction(candidate.action)) {
    throw new VerificationFailedError({ reason: 'invalid session credential action' })
  }
  return candidate.action
}

/** Validates the shared action and channel fields for a TIP-1034 session credential payload. */
export function requireSessionCredentialPayloadHeader(
  payload: unknown,
): SessionCredentialPayloadHeader {
  return readPayloadHeader(payload).header
}

/** Validates action-specific fields for a TIP-1034 session credential payload. */
export function requireSessionCredentialPayload(payload: unknown): SessionCredentialPayload {
  const { candidate, header } = readPayloadHeader(payload)
  switch (header.action) {
    case 'open':
      return {
        action: 'open',
        type: readTransactionType(candidate.type),
        channelId: header.channelId,
        transaction: readHex(candidate.transaction, 'transaction'),
        signature: readHex(candidate.signature, 'signature'),
        descriptor: readDescriptor(candidate.descriptor),
        cumulativeAmount: readRawAmount(candidate.cumulativeAmount, 'cumulativeAmount'),
        ...(candidate.authorizedSigner === undefined
          ? {}
          : {
              authorizedSigner: readAddress(candidate.authorizedSigner, 'authorizedSigner'),
            }),
      }
    case 'topUp':
      return {
        action: 'topUp',
        type: readTransactionType(candidate.type),
        channelId: header.channelId,
        transaction: readHex(candidate.transaction, 'transaction'),
        descriptor: readDescriptor(candidate.descriptor),
        additionalDeposit: readRawAmount(candidate.additionalDeposit, 'additionalDeposit'),
      }
    case 'voucher':
      return {
        action: 'voucher',
        channelId: header.channelId,
        descriptor: readDescriptor(candidate.descriptor),
        cumulativeAmount: readRawAmount(candidate.cumulativeAmount, 'cumulativeAmount'),
        signature: readHex(candidate.signature, 'signature'),
      }
    case 'close':
      return {
        action: 'close',
        channelId: header.channelId,
        descriptor: readDescriptor(candidate.descriptor),
        cumulativeAmount: readRawAmount(candidate.cumulativeAmount, 'cumulativeAmount'),
        signature: readHex(candidate.signature, 'signature'),
        closeSignature: readHex(candidate.closeSignature, 'closeSignature'),
      }
  }
}

function readTransactionType(value: unknown): 'transaction' {
  if (value === 'transaction') return value
  throw new VerificationFailedError({ reason: 'invalid session credential transaction type' })
}

/** Shared inputs required to broadcast a verified precompile session credential payload. */
export type BroadcastCredentialPayloadParameters = {
  /** Optional account override used for payee-side close settlement. */
  account?: viem_Account | undefined
  /** Challenge echoed by the credential. */
  challenge: Challenge.Challenge
  /** Milliseconds before voucher verification refreshes on-chain channel state. */
  channelStateTtl: number
  /** Chain ID used for channel ID derivation and voucher domain separation. */
  chainId: number
  /** viem client used for precompile reads and transaction broadcasts. */
  client: Chain.TransactionClient
  /** Optional payer identifier from the HTTP credential source field. */
  credentialSource?: string | undefined
  /** TIP20EscrowChannel precompile address for this session method. */
  escrow: Address
  /** Operator address advertised in the HMAC-bound challenge details. */
  expectedOperator?: Address | undefined
  /** Fee-payer account, or `true` when the client transport delegates co-signing to a hosted relay. */
  feePayer?: viem_Account | true | undefined
  /** Optional policy for fee-sponsored close/open/top-up transactions. */
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
  /** Optional fee token override for sponsored management and settlement transactions. */
  feeToken?: Address | undefined
  /** Last successful on-chain refresh timestamp per channel ID. */
  lastOnChainVerified: Map<Hex, number>
  /** Minimum allowed voucher delta in raw units. */
  minVoucherDelta: bigint
  /** Callback invoked after an on-chain settlement or close transaction is confirmed. */
  onSessionSettlement?: OnSessionSettlement | undefined
  /** Discriminated session credential payload to verify. */
  payload: SessionCredentialPayload
  /** Whether an open or voucher credential must add new funds for this request. */
  requireVoucherAdvance?: boolean | undefined
  /** Server-side channel store. */
  store: ChannelStore.ChannelStore
}

/** @deprecated Use {@link BroadcastCredentialPayloadParameters}. */
export type VerifyCredentialPayloadParameters = BroadcastCredentialPayloadParameters

/** Narrows shared credential broadcast inputs to one payload action. */
export type BroadcastCredentialActionParameters<action extends SessionCredentialPayload['action']> =
  Omit<BroadcastCredentialPayloadParameters, 'payload'> & {
    /** Credential payload for the selected action. */
    payload: Extract<SessionCredentialPayload, { action: action }>
  }

/** @deprecated Use {@link BroadcastCredentialActionParameters}. */
export type VerifyCredentialActionParameters<action extends SessionCredentialPayload['action']> =
  BroadcastCredentialActionParameters<action>

/** Inputs for broadcasting an open transaction credential and initial voucher. */
export type OpenCredentialActionParameters = BroadcastCredentialActionParameters<'open'>

/** Inputs for broadcasting a top-up transaction credential. */
export type TopUpCredentialActionParameters = BroadcastCredentialActionParameters<'topUp'>

/** Inputs for broadcasting and accepting an incremental voucher credential. */
export type VoucherCredentialActionParameters = BroadcastCredentialActionParameters<'voucher'>

/** Inputs for broadcasting and settling a cooperative close credential. */
export type CloseCredentialActionParameters = BroadcastCredentialActionParameters<'close'>

const refreshOnChainVerificationCache = {
  close: false,
  open: true,
  topUp: true,
  voucher: false,
} satisfies Record<SessionCredentialPayload['action'], boolean>

/** Inputs for validating a session credential without applying its state transition. */
export type ValidateCredentialPayloadParameters = Pick<
  BroadcastCredentialPayloadParameters,
  | 'account'
  | 'channelStateTtl'
  | 'chainId'
  | 'client'
  | 'credentialSource'
  | 'escrow'
  | 'expectedOperator'
  | 'feePayer'
  | 'feePayerPolicy'
  | 'feeToken'
  | 'lastOnChainVerified'
  | 'minVoucherDelta'
  | 'payload'
  | 'store'
  | 'challenge'
> & {
  operation?: 'broadcast' | 'validate' | undefined
}

/** Non-mutating result produced by session credential validation. */
export type CredentialPayloadValidation = {
  /** Session action validated from the credential. */
  action: SessionCredentialPayload['action']
  /** Normalized channel ID targeted by the credential. */
  channelId: Hex
}

/** Validates all action-specific session credential invariants without changing payment state. */
export async function validateCredentialPayload(
  parameters: ValidateCredentialPayloadParameters,
): Promise<CredentialPayloadValidation> {
  const { payload } = parameters
  switch (payload.action) {
    case 'open':
      await validateOpenCredential(parameters, payload)
      break
    case 'topUp':
      await validateTopUpCredential(parameters, payload)
      break
    case 'voucher':
      await validateVoucherCredential(parameters, payload)
      break
    case 'close':
      await validateCloseCredential(parameters, payload)
      break
  }
  return { action: payload.action, channelId: ChannelStore.normalizeChannelId(payload.channelId) }
}

async function validateOpenCredential(
  parameters: ValidateCredentialPayloadParameters,
  payload: Extract<SessionCredentialPayload, { action: 'open' }>,
) {
  const { challenge, chainId, client, escrow } = parameters
  const request = getChallengePaymentFields(challenge)
  const expectedOperator = parameters.expectedOperator ?? zeroAddress
  const cumulativeAmount = uint96(BigInt(payload.cumulativeAmount))
  assertDescriptor(payload)
  if (
    payload.authorizedSigner !== undefined &&
    !isAddressEqual(payload.authorizedSigner, payload.descriptor.authorizedSigner)
  )
    throw new VerificationFailedError({
      reason: 'credential authorizedSigner does not match descriptor',
    })
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  validateChannelDescriptor(
    payload.descriptor,
    channelId,
    chainId,
    escrow,
    request.recipient,
    request.currency,
    expectedOperator,
  )
  const transaction = Chain.validateOpenCredentialTransaction({
    allowedFeeTokens: allowedSponsoredFeeTokens(request.currency, parameters.feeToken),
    challengeExpires: challenge.expires,
    chainId,
    escrowContract: escrow,
    expectedAuthorizedSigner: payload.descriptor.authorizedSigner,
    expectedChannelId: channelId,
    expectedCurrency: request.currency,
    expectedOperator,
    expectedPayee: request.recipient,
    expectedExpiringNonceHash: payload.descriptor.expiringNonceHash,
    expectedPayer: payload.descriptor.payer,
    feePayer: parameters.feePayer,
    feePayerPolicy: parameters.feePayerPolicy,
    serializedTransaction: payload.transaction,
  })
  assertOpenCredentialCoversRequest({
    cumulativeAmount,
    openDeposit: transaction.openDeposit,
    requestAmount: request.amount,
  })
  assertSameDescriptor(transaction.descriptor, payload.descriptor)
  if (cumulativeAmount > transaction.openDeposit)
    throw new AmountExceedsDepositError({ reason: 'voucher amount exceeds open deposit' })
  const valid = await Voucher.verifyVoucher(
    escrow,
    chainId,
    { channelId, cumulativeAmount, signature: payload.signature },
    authorizedSigner(transaction.descriptor),
  )
  if (!valid) throw new InvalidSignatureError({ reason: 'invalid voucher signature' })
  await Chain.simulateCredentialTransaction({
    client,
    feePayer: parameters.feePayer,
    transaction: transaction.transaction,
  })
}

async function validateTopUpCredential(
  parameters: ValidateCredentialPayloadParameters,
  payload: Extract<SessionCredentialPayload, { action: 'topUp' }>,
) {
  const { challenge, chainId, client, escrow, store } = parameters
  const request = getChallengePaymentFields(challenge)
  const expectedOperator = parameters.expectedOperator ?? zeroAddress
  const additionalDeposit = uint96(BigInt(payload.additionalDeposit))
  assertDescriptor(payload)
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  validateChannelDescriptor(
    payload.descriptor,
    channelId,
    chainId,
    escrow,
    request.recipient,
    request.currency,
    expectedOperator,
  )
  const channel = await ChannelStore.loadPrecompileChannel({
    descriptor: payload.descriptor,
    channelId,
    chainId,
    escrow,
    store,
    validateDescriptor: true,
  })
  if (store.atomic === false)
    throw new VerificationFailedError({ reason: 'top-up coordination requires an atomic store' })
  if (channel.finalized) throw new ChannelClosedError({ reason: 'channel is finalized' })
  if (channel.closeRequestedAt !== 0n)
    throw new ChannelClosedError({ reason: 'channel has a pending close request' })
  if (ChannelStore.hasActiveCloseClaim(channel)) {
    if (parameters.operation === 'broadcast' && isConfirmedCloseClaim(channel.pendingCloseClaim))
      return
    throw new ChannelClosedError({ reason: 'channel close is already in progress' })
  }
  const topUpClaim = channel.pendingTopUpClaim
  if (
    ChannelStore.hasActiveTopUpClaim(channel) &&
    (topUpClaim?.expiresAt !== Number.MAX_SAFE_INTEGER || topUpClaim.deposit === undefined)
  )
    throw new VerificationFailedError({ reason: 'channel top-up is already in progress' })
  const state = await Chain.getChannelState(client, channelId, escrow)
  if (ChannelStore.hasActiveTopUpClaim(channel) && !isConfirmedTopUpReconciled(channel, state))
    throw new VerificationFailedError({ reason: 'channel top-up is already in progress' })
  const transaction = Chain.validateTopUpCredentialTransaction({
    additionalDeposit,
    allowedFeeTokens: allowedSponsoredFeeTokens(request.currency, parameters.feeToken),
    challengeExpires: challenge.expires,
    chainId,
    descriptor: channel.descriptor,
    escrowContract: escrow,
    expectedChannelId: channelId,
    expectedCurrency: request.currency,
    feePayer: parameters.feePayer,
    feePayerPolicy: parameters.feePayerPolicy,
    serializedTransaction: payload.transaction,
  })
  validateChannelState(state)
  await Chain.simulateCredentialTransaction({
    client,
    feePayer: parameters.feePayer,
    transaction: transaction.transaction,
  })
}

/** Returns whether a permanent top-up marker is reflected in current chain state. */
function isConfirmedTopUpReconciled(
  channel: ChannelStore.StoredPrecompileChannel,
  state: Chain.ChannelState,
): boolean {
  const claim = channel.pendingTopUpClaim
  return (
    claim?.expiresAt === Number.MAX_SAFE_INTEGER &&
    claim.deposit !== undefined &&
    state.deposit >= claim.deposit
  )
}

type PendingCloseClaim = NonNullable<ChannelStore.BaseState['pendingCloseClaim']>
type ConfirmedCloseClaim = PendingCloseClaim & {
  captureAmount: bigint
  cumulativeAmount: bigint
  deposit: bigint
  settledOnChain: bigint
  signature: Hex
  txHash: Hex
}

/** Returns whether a close marker contains everything needed for crash recovery. */
function isConfirmedCloseClaim(claim: PendingCloseClaim | undefined): claim is ConfirmedCloseClaim {
  return (
    claim?.expiresAt === Number.MAX_SAFE_INTEGER &&
    claim.captureAmount !== undefined &&
    claim.cumulativeAmount !== undefined &&
    claim.deposit !== undefined &&
    claim.settledOnChain !== undefined &&
    claim.signature !== undefined &&
    claim.txHash !== undefined
  )
}

/** Finalizes a close whose receipt was confirmed before local reconciliation completed. */
async function reconcileConfirmedCloseClaim(parameters: {
  channel: ChannelStore.StoredPrecompileChannel
  client: Chain.TransactionClient
  onSessionSettlement?: OnSessionSettlement | undefined
  store: ChannelStore.ChannelStore
}): Promise<ChannelStore.StoredPrecompileChannel> {
  const { channel, client, onSessionSettlement, store } = parameters
  const claim = channel.pendingCloseClaim
  if (!isConfirmedCloseClaim(claim)) return channel
  const receipt = await Chain.waitForSuccessfulReceipt(client, claim.txHash)
  const { refundedToPayer, settledToPayee } = readChannelClosedReceiptFields(
    Chain.getChannelEvent(receipt, 'ChannelClosed', channel.channelId),
  )
  if (
    settledToPayee < claim.settledOnChain ||
    settledToPayee > claim.captureAmount ||
    settledToPayee + refundedToPayer > claim.deposit
  )
    throw new VerificationFailedError({ reason: 'ChannelClosed amounts do not match state' })

  if (!store.updateChannelResult)
    throw new VerificationFailedError({ reason: 'close recovery requires an atomic store' })
  const recovery = await store.updateChannelResult<{
    channel: ChannelStore.State | null
    recovered: boolean
  }>(channel.channelId, (current) => {
    if (
      !current ||
      !ChannelStore.isPrecompileState(current) ||
      current.pendingCloseClaim?.id !== claim.id ||
      current.pendingCloseClaim.expiresAt !== Number.MAX_SAFE_INTEGER
    )
      return { op: 'noop', result: { channel: current, recovered: false } }
    const updated = ChannelStore.finalizeClosedChannelState({
      captureAmount: claim.captureAmount,
      channelId: channel.channelId,
      cumulativeAmount: claim.cumulativeAmount,
      current,
      signature: claim.signature,
    })!
    return {
      op: 'set',
      result: { channel: updated, recovered: true },
      value: updated,
    }
  })
  const updated = recovery.channel
  if (!updated) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (!ChannelStore.isPrecompileState(updated))
    throw new VerificationFailedError({ reason: 'channel is not precompile-backed' })
  if (recovery.recovered && onSessionSettlement) {
    try {
      await onSessionSettlement(
        Object.freeze({
          amount: settledToPayee,
          channelId: channel.channelId,
          delta: settledToPayee - claim.settledOnChain,
          trigger: 'close' as const,
          txHash: claim.txHash,
        }),
      )
    } catch {
      // Errors are isolated — observers cannot break close recovery.
    }
  }
  return updated
}

/** Clears a confirmed top-up marker after merging its on-chain deposit. */
async function reconcileConfirmedTopUpClaim(parameters: {
  channel: ChannelStore.StoredPrecompileChannel
  client: Chain.TransactionClient
  escrow: Address
  store: ChannelStore.ChannelStore
}): Promise<ChannelStore.StoredPrecompileChannel> {
  const { channel, client, escrow, store } = parameters
  const claim = channel.pendingTopUpClaim
  if (!claim || claim.expiresAt !== Number.MAX_SAFE_INTEGER || claim.deposit === undefined)
    return channel
  const state = await Chain.getChannelState(client, channel.channelId, escrow)
  if (!isConfirmedTopUpReconciled(channel, state)) return channel
  const updated = await store.updateChannel(channel.channelId, (current) => {
    if (
      !current ||
      !ChannelStore.isPrecompileState(current) ||
      current.pendingTopUpClaim?.id !== claim.id ||
      current.pendingTopUpClaim.expiresAt !== Number.MAX_SAFE_INTEGER
    )
      return current
    const toppedUp = ChannelStore.topUpChannelState({ current, state })
    if (!toppedUp) return toppedUp
    const { pendingTopUpClaim: _, ...withoutClaim } = toppedUp
    return withoutClaim
  })
  if (!updated) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (!ChannelStore.isPrecompileState(updated))
    throw new VerificationFailedError({ reason: 'channel is not precompile-backed' })
  return updated
}

async function validateVoucherCredential(
  parameters: ValidateCredentialPayloadParameters,
  payload: Extract<SessionCredentialPayload, { action: 'voucher' }>,
) {
  const {
    challenge,
    chainId,
    client,
    credentialSource,
    escrow,
    minVoucherDelta,
    store,
    channelStateTtl,
    lastOnChainVerified,
  } = parameters
  const request = getChallengePaymentFields(challenge)
  const expectedOperator = parameters.expectedOperator ?? zeroAddress
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  const voucher = Voucher.parseVoucherFromPayload(
    channelId,
    payload.cumulativeAmount,
    payload.signature,
  )
  assertDescriptor(payload)
  validateChannelDescriptor(
    payload.descriptor,
    channelId,
    chainId,
    escrow,
    request.recipient,
    request.currency,
    expectedOperator,
  )
  const channel = await ChannelStore.loadPrecompileChannel({
    descriptor: payload.descriptor,
    channelId,
    chainId,
    escrow,
    store,
    validateDescriptor: true,
  })
  assertCredentialSourceCanSpend({ chainId, channel, source: credentialSource })
  if (channel.finalized) throw new ChannelClosedError({ reason: 'channel is finalized' })
  if (ChannelStore.hasActiveCloseClaim(channel)) {
    if (parameters.operation === 'broadcast' && isConfirmedCloseClaim(channel.pendingCloseClaim))
      return
    throw new ChannelClosedError({ reason: 'channel close is already in progress' })
  }
  const channelState = await resolveVoucherChannelState({
    channel,
    channelId,
    channelStateTtl,
    client,
    escrow,
    forceRefresh: true,
    lastOnChainVerified,
  })
  if (channelState.closeRequestedAt !== 0) {
    await authenticatePendingCloseVoucher({
      chainId,
      channel,
      channelState,
      escrow,
      voucher,
    })
    if (parameters.operation !== 'broadcast')
      throw new ChannelClosedError({ reason: 'channel has a pending close request' })
    return
  }
  await ChannelStore.validateVoucher({
    channel,
    channelState,
    methodDetails: { chainId, escrowContract: escrow },
    minVoucherDelta,
    voucher,
  })
}

async function authenticatePendingCloseVoucher(parameters: {
  chainId: number
  channel: ChannelStore.StoredPrecompileChannel
  channelState: Chain.ChannelState
  escrow: Address
  voucher: SignedVoucher
}): Promise<void> {
  const { chainId, channel, channelState, escrow, voucher } = parameters
  if (channelState.deposit === 0n)
    throw new ChannelNotFoundError({ reason: 'channel not funded on-chain' })
  if (voucher.cumulativeAmount > channelState.deposit)
    throw new AmountExceedsDepositError({ reason: 'voucher amount exceeds on-chain deposit' })
  const valid = await Voucher.verifyVoucher(escrow, chainId, voucher, channel.authorizedSigner)
  if (!valid) throw new InvalidSignatureError({ reason: 'invalid voucher signature' })
}

type PendingCloseSettlementParameters = Pick<
  BroadcastCredentialPayloadParameters,
  | 'account'
  | 'client'
  | 'feePayer'
  | 'feePayerPolicy'
  | 'feeToken'
  | 'onSessionSettlement'
  | 'store'
> & {
  channel: ChannelStore.StoredPrecompileChannel
  channelState: Chain.ChannelState
}

/**
 * Persists a detected force-close request, settles any accepted voucher not yet
 * reflected on-chain, then always rejects the credential as a closed channel.
 */
async function settleDetectedPendingClose(
  parameters: PendingCloseSettlementParameters,
): Promise<void> {
  const { channel, channelState, store } = parameters
  if (channelState.closeRequestedAt === 0) return

  const updated = await store.updateChannel(channel.channelId, (current) => {
    if (!current) return current
    const closeRequestedAt =
      BigInt(channelState.closeRequestedAt) > current.closeRequestedAt
        ? BigInt(channelState.closeRequestedAt)
        : current.closeRequestedAt
    const settledOnChain =
      channelState.settled > current.settledOnChain ? channelState.settled : current.settledOnChain
    return { ...current, closeRequestedAt, settledOnChain }
  })
  if (!updated) throw new ChannelNotFoundError({ reason: 'channel not found' })

  const amount = updated.highestVoucher?.cumulativeAmount
  if (amount !== undefined && amount > updated.settledOnChain) {
    const options = {
      account: parameters.account,
      ...(parameters.feePayer ? { feePayer: parameters.feePayer } : {}),
      ...(parameters.feePayerPolicy ? { feePayerPolicy: parameters.feePayerPolicy } : {}),
      ...(parameters.feeToken ? { feeToken: parameters.feeToken } : {}),
      onSessionSettlement: parameters.onSessionSettlement,
    }
    while (true) {
      const txHash = await settleIfAvailable(store, parameters.client, updated.channelId, options)
      if (txHash) break

      const waitForUpdate = store.waitForUpdate?.(updated.channelId)
      const current = await store.getChannel(updated.channelId)
      if (!current) throw new ChannelNotFoundError({ reason: 'channel not found' })
      const outstanding = current.highestVoucher?.cumulativeAmount
      if (outstanding === undefined || outstanding <= current.settledOnChain) break
      const settlementClaim = current.pendingSettlementClaim
      if (settlementClaim && settlementClaim.expiresAt > Date.now()) {
        await waitForSettlementClaimUpdate(waitForUpdate, settlementClaim.expiresAt)
        continue
      }
      const closeClaim = current.pendingCloseClaim
      if (closeClaim && closeClaim.expiresAt > Date.now()) {
        if (closeClaim.expiresAt === Number.MAX_SAFE_INTEGER) break
        await waitForSettlementClaimUpdate(waitForUpdate, closeClaim.expiresAt)
      }
    }
  }

  throw new ChannelClosedError({ reason: 'channel has a pending close request' })
}

/** Waits for a settlement owner to publish progress or for its lease to expire. */
async function waitForSettlementClaimUpdate(
  update: Promise<void> | undefined,
  expiresAt: number,
): Promise<void> {
  const remaining = expiresAt - Date.now()
  const delay = Math.max(0, Math.min(remaining, 1_000))
  if (delay === 0) return
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, delay)
    ;(timer as unknown as { unref?: () => void }).unref?.()
  })
  try {
    await (update ? Promise.race([update, timeout]) : timeout)
  } finally {
    if (timer) clearTimeout(timer)
  }
}

async function resolveVoucherChannelState(parameters: {
  channel: ChannelStore.State
  channelId: Hex
  channelStateTtl: number
  client: Chain.TransactionClient
  escrow: Address
  forceRefresh?: boolean | undefined
  lastOnChainVerified: Map<Hex, number>
}): Promise<Chain.ChannelState> {
  const { channel, channelId, channelStateTtl, client, escrow, forceRefresh, lastOnChainVerified } =
    parameters
  const shouldRefresh =
    forceRefresh || Date.now() - (lastOnChainVerified.get(channelId) ?? 0) > channelStateTtl
  const state = shouldRefresh ? await Chain.getChannelState(client, channelId, escrow) : undefined
  if (state?.closeRequestedAt === 0) lastOnChainVerified.set(channelId, Date.now())
  else if (state) lastOnChainVerified.delete(channelId)
  return {
    deposit: state?.deposit ?? uint96(channel.deposit),
    settled: state?.settled ?? uint96(channel.settledOnChain),
    closeRequestedAt: state?.closeRequestedAt ?? Number(channel.closeRequestedAt),
  }
}

async function validateCloseCredential(
  parameters: ValidateCredentialPayloadParameters,
  payload: Extract<SessionCredentialPayload, { action: 'close' }>,
) {
  const { challenge, chainId, client, escrow, store } = parameters
  const request = getChallengePaymentFields(challenge)
  const expectedOperator = parameters.expectedOperator ?? zeroAddress
  const cumulativeAmount = uint96(BigInt(payload.cumulativeAmount))
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  assertDescriptor(payload)
  validateChannelDescriptor(
    payload.descriptor,
    channelId,
    chainId,
    escrow,
    request.recipient,
    request.currency,
    expectedOperator,
  )
  const channel = await ChannelStore.loadPrecompileChannel({
    descriptor: payload.descriptor,
    channelId,
    chainId,
    escrow,
    store,
  })
  const closeAuthorized = Voucher.verifyCloseAuthorization(
    escrow,
    chainId,
    { channelId, cumulativeAmount, signature: payload.closeSignature },
    [channel.payer, channel.authorizedSigner],
  )
  if (!closeAuthorized)
    throw new InvalidSignatureError({ reason: 'invalid close authorization signature' })
  if (store.atomic === false)
    throw new VerificationFailedError({ reason: 'close coordination requires an atomic store' })
  if (channel.finalized) throw new ChannelClosedError({ reason: 'channel is already finalized' })
  if (ChannelStore.hasActiveCloseClaim(channel)) {
    if (parameters.operation === 'broadcast' && isConfirmedCloseClaim(channel.pendingCloseClaim))
      return
    throw new ChannelClosedError({ reason: 'channel close is already in progress' })
  }
  const settlementClaim = channel.pendingSettlementClaim
  if (
    ChannelStore.hasActiveSettlementClaim(channel) &&
    (parameters.operation !== 'broadcast' || settlementClaim?.expiresAt !== Number.MAX_SAFE_INTEGER)
  )
    throw new VerificationFailedError({ reason: 'channel settlement is already in progress' })
  const topUpClaim = channel.pendingTopUpClaim
  if (
    ChannelStore.hasActiveTopUpClaim(channel) &&
    (topUpClaim?.expiresAt !== Number.MAX_SAFE_INTEGER || topUpClaim.deposit === undefined)
  )
    throw new VerificationFailedError({ reason: 'channel top-up is already in progress' })
  const state = await Chain.getChannelState(client, channelId, escrow)
  if (
    ChannelStore.hasActiveSettlementClaim(channel) &&
    !(
      parameters.operation === 'broadcast' &&
      settlementClaim?.expiresAt === Number.MAX_SAFE_INTEGER &&
      state.settled >= settlementClaim.amount
    )
  )
    throw new VerificationFailedError({ reason: 'channel settlement is already in progress' })
  if (ChannelStore.hasActiveTopUpClaim(channel) && !isConfirmedTopUpReconciled(channel, state))
    throw new VerificationFailedError({ reason: 'channel top-up is already in progress' })
  if (state.closeRequestedAt !== 0)
    throw new ChannelClosedError({ reason: 'channel has a pending close request' })
  const onChainDeposit =
    state.deposit === 0n ? 0n : channel.deposit > state.deposit ? channel.deposit : state.deposit
  if (onChainDeposit === 0n && (cumulativeAmount !== 0n || channel.spent !== 0n))
    throw new ChannelClosedError({ reason: 'channel deposit is zero (settled)' })
  if (cumulativeAmount < channel.spent)
    throw new VerificationFailedError({
      reason: `close voucher amount must be >= ${channel.spent} (spent)`,
    })
  const onChainSettled =
    channel.settledOnChain > state.settled ? channel.settledOnChain : state.settled
  if (cumulativeAmount < onChainSettled)
    throw new VerificationFailedError({
      reason: `close voucher amount must be >= ${onChainSettled} (on-chain settled)`,
    })
  const valid = await Voucher.verifyVoucher(
    escrow,
    chainId,
    { channelId, cumulativeAmount, signature: payload.signature },
    channel.authorizedSigner,
  )
  if (!valid) throw new InvalidSignatureError({ reason: 'invalid voucher signature' })
  const captureAmount = uint96(channel.spent > onChainSettled ? channel.spent : onChainSettled)
  if (captureAmount > onChainDeposit)
    throw new AmountExceedsDepositError({ reason: 'close capture amount exceeds on-chain deposit' })
  const account = parameters.account ?? getClientAccount(client)
  assertSettlementSender({
    operation: 'close',
    channelId,
    operator: channel.operator,
    payee: channel.payee,
    sender: account?.address,
  })
}

/** Broadcasts a validated session credential payload and applies its state transition. */
export async function broadcastCredentialPayload(
  context: BroadcastCredentialPayloadParameters,
): Promise<SessionReceipt> {
  const receipt = await broadcastCredentialAction(context)
  if (refreshOnChainVerificationCache[context.payload.action])
    context.lastOnChainVerified.set(receipt.channelId, Date.now())
  return receipt
}

/** @deprecated Use {@link broadcastCredentialPayload}. */
export async function verifyCredentialPayload(
  context: VerifyCredentialPayloadParameters,
): Promise<SessionReceipt> {
  return broadcastCredentialPayload(context)
}

function broadcastCredentialAction(
  context: BroadcastCredentialPayloadParameters,
): Promise<SessionReceipt> {
  const { payload } = context
  switch (payload.action) {
    case 'open':
      return handleOpenCredential(actionContext(context, payload))
    case 'topUp':
      return handleTopUpCredential(actionContext(context, payload))
    case 'voucher':
      return handleVoucherCredential(actionContext(context, payload))
    case 'close':
      return handleCloseCredential(actionContext(context, payload))
  }
}

function actionContext<action extends SessionCredentialPayload['action']>(
  context: BroadcastCredentialPayloadParameters,
  payload: Extract<SessionCredentialPayload, { action: action }>,
): BroadcastCredentialActionParameters<action> {
  return { ...context, payload }
}

async function handleOpenCredential(
  parameters: OpenCredentialActionParameters,
): Promise<SessionReceipt> {
  const { store, client, challenge, payload, chainId, escrow } = parameters
  const request = getChallengePaymentFields(challenge)
  const expectedOperator = parameters.expectedOperator ?? zeroAddress
  const cumulativeAmount = uint96(BigInt(payload.cumulativeAmount))
  assertDescriptor(payload)
  if (
    payload.authorizedSigner !== undefined &&
    !isAddressEqual(payload.authorizedSigner, payload.descriptor.authorizedSigner)
  )
    throw new VerificationFailedError({
      reason: 'credential authorizedSigner does not match descriptor',
    })
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  validateChannelDescriptor(
    payload.descriptor,
    channelId,
    chainId,
    escrow,
    request.recipient,
    request.currency,
    expectedOperator,
  )

  const result = await Chain.broadcastOpenTransaction({
    allowedFeeTokens: allowedSponsoredFeeTokens(request.currency, parameters.feeToken),
    challengeExpires: challenge.expires,
    chainId,
    client,
    escrowContract: escrow,
    expectedAuthorizedSigner: payload.descriptor.authorizedSigner,
    expectedChannelId: channelId,
    expectedCurrency: request.currency,
    expectedOperator,
    expectedPayee: request.recipient,
    expectedExpiringNonceHash: payload.descriptor.expiringNonceHash,
    expectedPayer: payload.descriptor.payer,
    feePayer: parameters.feePayer,
    feePayerPolicy: parameters.feePayerPolicy,
    serializedTransaction: payload.transaction,
    async beforeBroadcast(prepared) {
      assertOpenCredentialCoversRequest({
        cumulativeAmount,
        openDeposit: prepared.openDeposit,
        requestAmount: request.amount,
      })
      assertSameDescriptor(prepared.descriptor, payload.descriptor)
      if (cumulativeAmount > prepared.openDeposit)
        throw new AmountExceedsDepositError({ reason: 'voucher amount exceeds open deposit' })
      const valid = await Voucher.verifyVoucher(
        escrow,
        chainId,
        { channelId, cumulativeAmount: cumulativeAmount, signature: payload.signature },
        authorizedSigner(prepared.descriptor),
      )
      if (!valid) throw new InvalidSignatureError({ reason: 'invalid voucher signature' })
    },
  })
  const { descriptor, state } = result
  assertSameDescriptor(descriptor, payload.descriptor)
  validateChannelState(state, request.amount)

  const updated = await store.updateChannel(channelId, (current) => {
    if (
      parameters.requireVoucherAdvance &&
      current !== null &&
      cumulativeAmount <= current.highestVoucherAmount
    )
      throw new DeltaTooSmallError({
        reason: 'voucher does not add new funds for this request',
      })
    return ChannelStore.openChannelState({
      authorizedSigner: authorizedSigner(descriptor),
      chainId,
      channelId,
      current,
      descriptor,
      escrow,
      expiringNonceHash: result.expiringNonceHash,
      cumulativeAmount,
      signature: payload.signature,
      state,
    })
  })
  if (!updated) throw new VerificationFailedError({ reason: 'failed to create channel' })
  return createSessionReceipt({
    challengeId: challenge.id,
    channelId,
    acceptedCumulative: updated.highestVoucherAmount,
    spent: updated.spent,
    units: updated.units,
    txHash: result.txHash,
  })
}

async function handleTopUpCredential(
  parameters: TopUpCredentialActionParameters,
): Promise<SessionReceipt> {
  const { store, client, challenge, payload, chainId, escrow } = parameters
  const request = getChallengePaymentFields(challenge)
  const expectedOperator = parameters.expectedOperator ?? zeroAddress
  const additionalDeposit = uint96(BigInt(payload.additionalDeposit))
  assertDescriptor(payload)
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  validateChannelDescriptor(
    payload.descriptor,
    channelId,
    chainId,
    escrow,
    request.recipient,
    request.currency,
    expectedOperator,
  )
  let channel = await ChannelStore.loadPrecompileChannel({
    descriptor: payload.descriptor,
    channelId,
    chainId,
    escrow,
    store,
    validateDescriptor: true,
  })
  if (store.atomic === false)
    throw new VerificationFailedError({ reason: 'top-up coordination requires an atomic store' })
  channel = await reconcileConfirmedCloseClaim({
    channel,
    client,
    onSessionSettlement: parameters.onSessionSettlement,
    store,
  })
  if (channel.finalized) throw new ChannelClosedError({ reason: 'channel is finalized' })
  channel = await reconcileConfirmedTopUpClaim({ channel, client, escrow, store })
  const topUpTransaction = {
    additionalDeposit,
    allowedFeeTokens: allowedSponsoredFeeTokens(request.currency, parameters.feeToken),
    challengeExpires: challenge.expires,
    chainId,
    descriptor: channel.descriptor,
    escrowContract: escrow,
    expectedChannelId: channelId,
    expectedCurrency: request.currency,
    feePayer: parameters.feePayer,
    feePayerPolicy: parameters.feePayerPolicy,
    serializedTransaction: payload.transaction,
  } as const
  Chain.validateTopUpCredentialTransaction(topUpTransaction)
  const claim = {
    deposit: channel.deposit + additionalDeposit,
    expiresAt: Date.now() + ChannelStore.channelTransactionClaimTtlMs,
    id: globalThis.crypto.randomUUID(),
  }
  const claimed = await store.updateChannel(channelId, (current) => {
    if (
      !current ||
      current.finalized ||
      current.closeRequestedAt !== 0n ||
      ChannelStore.hasActiveCloseClaim(current)
    )
      return current
    if (ChannelStore.hasActiveTopUpClaim(current)) return current
    return { ...current, pendingTopUpClaim: claim }
  })
  if (!claimed) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (claimed.pendingTopUpClaim?.id !== claim.id) {
    if (claimed.finalized) throw new ChannelClosedError({ reason: 'channel is finalized' })
    if (claimed.closeRequestedAt !== 0n)
      throw new ChannelClosedError({ reason: 'channel has a pending close request' })
    if (ChannelStore.hasActiveCloseClaim(claimed))
      throw new ChannelClosedError({ reason: 'channel close is already in progress' })
    throw new VerificationFailedError({ reason: 'channel top-up is already in progress' })
  }

  let topUpConfirmed = false
  let topUpConfirmation: { deposit: bigint; txHash: Hex } | undefined
  let topUpPinWriteCompleted = false
  let topUpPinned = false
  const stopMaintainingTopUpClaim = maintainPendingTopUpClaim({
    claimId: claim.id,
    channelId,
    getConfirmation: () => topUpConfirmation,
    store,
  })
  let submissionStarted = false
  try {
    const result = await Chain.broadcastTopUpTransaction({
      ...topUpTransaction,
      client,
      async onConfirmation(txHash) {
        topUpConfirmed = true
        topUpConfirmation = { deposit: claim.deposit, txHash }
        const pinned = await store.updateChannel(channelId, (current) => {
          if (!current || current.finalized) return current
          if (
            current.pendingTopUpClaim?.id !== claim.id &&
            ChannelStore.hasActiveTopUpClaim(current)
          )
            return current
          return {
            ...current,
            pendingTopUpClaim: {
              expiresAt: Number.MAX_SAFE_INTEGER,
              id: claim.id,
              ...topUpConfirmation,
            },
          }
        })
        topUpPinWriteCompleted = true
        if (
          pinned &&
          !pinned.finalized &&
          (pinned.pendingTopUpClaim?.id !== claim.id || !ChannelStore.hasActiveTopUpClaim(pinned))
        ) {
          stopMaintainingTopUpClaim()
          throw new VerificationFailedError({ reason: 'failed to retain confirmed top-up state' })
        }
        topUpPinned = true
        stopMaintainingTopUpClaim()
      },
      onSubmission: () => {
        submissionStarted = true
      },
    })
    const { state } = result
    validateChannelState(state)
    const updated = await store.updateChannel(channelId, (current) => {
      const toppedUp = ChannelStore.topUpChannelState({ current, state })
      if (!toppedUp || toppedUp.pendingTopUpClaim?.id !== claim.id) return toppedUp
      const { pendingTopUpClaim: _, ...withoutClaim } = toppedUp
      return withoutClaim
    })
    return createSessionReceipt({
      challengeId: challenge.id,
      channelId,
      acceptedCumulative: updated?.highestVoucherAmount ?? channel.highestVoucherAmount,
      spent: updated?.spent ?? channel.spent,
      units: updated?.units ?? channel.units,
      txHash: result.txHash,
    })
  } catch (error) {
    if (!topUpConfirmed || topUpPinned || topUpPinWriteCompleted) stopMaintainingTopUpClaim()
    if (!submissionStarted || Chain.isConfirmedTransactionRevert(error))
      await store.updateChannel(channelId, (current) => {
        if (!current || current.pendingTopUpClaim?.id !== claim.id) return current
        const { pendingTopUpClaim: _, ...withoutClaim } = current
        return withoutClaim
      })
    throw error
  }
}

async function handleVoucherCredential(
  parameters: VoucherCredentialActionParameters,
): Promise<SessionReceipt> {
  const {
    store,
    client,
    challenge,
    credentialSource,
    payload,
    chainId,
    escrow,
    minVoucherDelta,
    channelStateTtl,
    lastOnChainVerified,
  } = parameters
  const request = getChallengePaymentFields(challenge)
  const expectedOperator = parameters.expectedOperator ?? zeroAddress
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  const voucher = Voucher.parseVoucherFromPayload(
    channelId,
    payload.cumulativeAmount,
    payload.signature,
  )
  assertDescriptor(payload)
  validateChannelDescriptor(
    payload.descriptor,
    channelId,
    chainId,
    escrow,
    request.recipient,
    request.currency,
    expectedOperator,
  )
  let channel = await ChannelStore.loadPrecompileChannel({
    descriptor: payload.descriptor,
    channelId,
    chainId,
    escrow,
    store,
    validateDescriptor: true,
  })
  channel = await reconcileConfirmedCloseClaim({
    channel,
    client,
    onSessionSettlement: parameters.onSessionSettlement,
    store,
  })
  assertCredentialSourceCanSpend({ chainId, channel, source: credentialSource })
  if (channel.finalized) throw new ChannelClosedError({ reason: 'channel is finalized' })
  const channelState = await resolveVoucherChannelState({
    channel,
    channelId,
    channelStateTtl,
    client,
    escrow,
    forceRefresh: true,
    lastOnChainVerified,
  })
  if (channelState.closeRequestedAt !== 0) {
    await authenticatePendingCloseVoucher({
      chainId,
      channel,
      channelState,
      escrow,
      voucher,
    })
  }
  await settleDetectedPendingClose({ ...parameters, channel, channelState })
  return ChannelStore.verifyAndAcceptVoucher({
    store,
    minVoucherDelta,
    requireAdvance: parameters.requireVoucherAdvance,
    challenge,
    channel,
    voucher,
    channelState,
    methodDetails: { chainId, escrowContract: escrow },
  })
}

async function handleCloseCredential(
  parameters: CloseCredentialActionParameters,
): Promise<SessionReceipt> {
  const { store, client, challenge, payload, chainId, escrow } = parameters
  const request = getChallengePaymentFields(challenge)
  const expectedOperator = parameters.expectedOperator ?? zeroAddress
  const cumulativeAmount = uint96(BigInt(payload.cumulativeAmount))
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  assertDescriptor(payload)
  validateChannelDescriptor(
    payload.descriptor,
    channelId,
    chainId,
    escrow,
    request.recipient,
    request.currency,
    expectedOperator,
  )
  let channel = await ChannelStore.loadPrecompileChannel({
    descriptor: payload.descriptor,
    channelId,
    chainId,
    escrow,
    store,
  })
  const closeAuthorized = Voucher.verifyCloseAuthorization(
    escrow,
    chainId,
    { channelId, cumulativeAmount, signature: payload.closeSignature },
    [channel.payer, channel.authorizedSigner],
  )
  if (!closeAuthorized)
    throw new InvalidSignatureError({ reason: 'invalid close authorization signature' })
  if (store.atomic === false)
    throw new VerificationFailedError({ reason: 'close coordination requires an atomic store' })
  channel = await reconcileConfirmedCloseClaim({
    channel,
    client,
    onSessionSettlement: parameters.onSessionSettlement,
    store,
  })
  if (channel.finalized) throw new ChannelClosedError({ reason: 'channel is already finalized' })
  channel = await reconcileConfirmedSettlementClaim({
    channel,
    client,
    options: {
      escrowContract: escrow,
      onSessionSettlement: parameters.onSessionSettlement,
    },
    store,
  })
  channel = await reconcileConfirmedTopUpClaim({ channel, client, escrow, store })
  if (channel.finalized) throw new ChannelClosedError({ reason: 'channel is already finalized' })
  const state = await Chain.getChannelState(client, channelId, escrow)
  if (state.closeRequestedAt !== 0)
    throw new ChannelClosedError({ reason: 'channel has a pending close request' })
  const storedDeposit =
    state.deposit === 0n ? 0n : channel.deposit > state.deposit ? channel.deposit : state.deposit
  if (storedDeposit === 0n && (cumulativeAmount !== 0n || channel.spent !== 0n))
    throw new ChannelClosedError({ reason: 'channel deposit is zero (settled)' })
  if (cumulativeAmount < channel.spent)
    throw new VerificationFailedError({
      reason: `close voucher amount must be >= ${channel.spent} (spent)`,
    })
  if (cumulativeAmount < state.settled)
    throw new VerificationFailedError({
      reason: `close voucher amount must be >= ${state.settled} (on-chain settled)`,
    })
  const valid = await Voucher.verifyVoucher(
    escrow,
    chainId,
    { channelId, cumulativeAmount: cumulativeAmount, signature: payload.signature },
    channel.authorizedSigner,
  )
  if (!valid) throw new InvalidSignatureError({ reason: 'invalid voucher signature' })
  let captureAmount = uint96(channel.spent > state.settled ? channel.spent : state.settled)
  if (captureAmount > storedDeposit)
    throw new AmountExceedsDepositError({ reason: 'close capture amount exceeds on-chain deposit' })
  const pendingCloseClaim = {
    expiresAt: Date.now() + ChannelStore.channelTransactionClaimTtlMs,
    id: globalThis.crypto.randomUUID(),
  }
  const pending = await store.updateChannel(channelId, (current) => {
    const onChainSettled =
      current && current.settledOnChain > state.settled ? current.settledOnChain : state.settled
    const onChainDeposit =
      state.deposit === 0n
        ? 0n
        : current && current.deposit > state.deposit
          ? current.deposit
          : state.deposit
    return ChannelStore.markPendingClose({
      claim: pendingCloseClaim,
      cumulativeAmount,
      current,
      onChainDeposit,
      onChainSettled,
    }).state
  })
  if (!pending) throw new ChannelNotFoundError({ reason: 'channel not found' })
  const pendingCloseMarked = pending.pendingCloseClaim?.id === pendingCloseClaim.id
  if (!pendingCloseMarked)
    throw new ChannelClosedError({ reason: 'channel close is already in progress' })
  const onChainSettled =
    pending.settledOnChain > state.settled ? pending.settledOnChain : state.settled
  const onChainDeposit =
    state.deposit === 0n ? 0n : pending.deposit > state.deposit ? pending.deposit : state.deposit
  captureAmount = ChannelStore.resolveCloseCaptureAmount({
    cumulativeAmount,
    onChainDeposit,
    onChainSettled,
    spent: pending.spent,
  })
  let closeConfirmation:
    | {
        captureAmount: bigint
        cumulativeAmount: bigint
        deposit: bigint
        settledOnChain: bigint
        signature: Hex
        txHash: Hex
      }
    | undefined
  const stopMaintainingCloseClaim = maintainPendingCloseClaim({
    claimId: pendingCloseClaim.id,
    channelId,
    getConfirmation: () => closeConfirmation,
    store,
  })
  const account = parameters.account ?? getClientAccount(client)
  let txHash: Hex | undefined
  let submissionStarted = false
  let receipt: Awaited<ReturnType<typeof Chain.waitForSuccessfulReceipt>>
  try {
    assertSettlementSender({
      operation: 'close',
      channelId,
      operator: channel.operator,
      payee: channel.payee,
      sender: account?.address,
    })
    txHash = await Chain.closeOnChain(
      client,
      channel.descriptor,
      cumulativeAmount,
      captureAmount,
      payload.signature,
      escrow,
      account
        ? {
            account,
            ...(parameters.feePayer ? { feePayer: parameters.feePayer } : {}),
            ...(parameters.feePayerPolicy ? { feePayerPolicy: parameters.feePayerPolicy } : {}),
            ...(parameters.feeToken ? { feeToken: parameters.feeToken } : {}),
            candidateFeeTokens: [channel.token],
            onSubmission: () => {
              submissionStarted = true
            },
          }
        : undefined,
    )
    receipt = await Chain.waitForSuccessfulReceipt(client, txHash)
    closeConfirmation = {
      captureAmount,
      cumulativeAmount,
      deposit: onChainDeposit,
      settledOnChain: onChainSettled,
      signature: payload.signature,
      txHash,
    }
  } catch (error) {
    stopMaintainingCloseClaim()
    const definitiveFailure =
      (!submissionStarted && txHash === undefined) || Chain.isConfirmedTransactionRevert(error)
    if (!definitiveFailure) throw error
    if (pendingCloseMarked) {
      await store.updateChannel(channelId, (current) => {
        if (!current || current.pendingCloseClaim?.id !== pendingCloseClaim.id) return current
        const { pendingCloseClaim: _, ...withoutCloseClaim } = current
        return withoutCloseClaim
      })
    }
    let latestState: Chain.ChannelState
    try {
      latestState = await Chain.getChannelState(client, channelId, escrow)
    } catch {
      throw error
    }
    if (latestState.closeRequestedAt !== 0)
      await settleDetectedPendingClose({
        ...parameters,
        channel,
        channelState: latestState,
      })
    throw error
  }
  if (!closeConfirmation)
    throw new VerificationFailedError({ reason: 'confirmed close metadata is unavailable' })
  const pinned = await pinConfirmedCloseClaim(closeConfirmation)
  if (
    pinned &&
    !pinned.finalized &&
    (pinned.pendingCloseClaim?.id !== pendingCloseClaim.id ||
      !ChannelStore.hasActiveCloseClaim(pinned))
  ) {
    stopMaintainingCloseClaim()
    throw new VerificationFailedError({ reason: 'failed to retain confirmed close state' })
  }
  stopMaintainingCloseClaim()
  const closed = readChannelClosedReceiptFields(
    Chain.getChannelEvent(receipt, 'ChannelClosed', channelId),
  )
  const { refundedToPayer, settledToPayee } = closed
  if (
    settledToPayee < onChainSettled ||
    settledToPayee > captureAmount ||
    settledToPayee + refundedToPayer > onChainDeposit
  )
    throw new VerificationFailedError({ reason: 'ChannelClosed amounts do not match state' })
  const updated = await store.updateChannel(channelId, (current) =>
    ChannelStore.finalizeClosedChannelState({
      captureAmount,
      channelId,
      cumulativeAmount,
      current,
      signature: payload.signature,
    }),
  )
  if (parameters.onSessionSettlement && txHash) {
    try {
      await parameters.onSessionSettlement(
        Object.freeze({
          txHash,
          channelId,
          trigger: 'close' as const,
          amount: settledToPayee,
          delta: settledToPayee - onChainSettled,
        }),
      )
    } catch {
      // Errors are isolated — observers cannot break the settlement flow.
    }
  }
  return createSessionReceipt({
    challengeId: challenge.id,
    channelId,
    acceptedCumulative: cumulativeAmount,
    spent: updated?.spent ?? channel.spent,
    units: updated?.units ?? channel.units,
    txHash,
  })

  /** Retries the safety marker until the confirmed close is durably pinned. */
  async function pinConfirmedCloseClaim(
    confirmation: NonNullable<typeof closeConfirmation>,
  ): Promise<ChannelStore.State | null> {
    while (true) {
      try {
        return await store.updateChannel(channelId, (current) => {
          if (!current || current.finalized) return current
          if (
            current.pendingCloseClaim &&
            current.pendingCloseClaim.id !== pendingCloseClaim.id &&
            ChannelStore.hasActiveCloseClaim(current)
          )
            return current
          return {
            ...current,
            pendingCloseClaim: {
              expiresAt: Number.MAX_SAFE_INTEGER,
              id: pendingCloseClaim.id,
              ...confirmation,
            },
          }
        })
      } catch {
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 1_000)
          ;(timer as unknown as { unref?: () => void }).unref?.()
        })
      }
    }
  }
}

/** Renews a cooperative-close lease while its transaction awaits confirmation. */
function maintainPendingCloseClaim(parameters: {
  claimId: string
  channelId: Hex
  getConfirmation: () =>
    | {
        captureAmount: bigint
        cumulativeAmount: bigint
        deposit: bigint
        settledOnChain: bigint
        signature: Hex
        txHash: Hex
      }
    | undefined
  store: ChannelStore.ChannelStore
}): () => void {
  const { claimId, channelId, getConfirmation, store } = parameters
  const timer = setInterval(() => {
    void store
      .updateChannel(channelId, (current) => {
        if (!current || current.pendingCloseClaim?.id !== claimId) return current
        const confirmation = getConfirmation()
        return {
          ...current,
          pendingCloseClaim: {
            ...current.pendingCloseClaim,
            ...(confirmation ?? {}),
            expiresAt: confirmation
              ? Number.MAX_SAFE_INTEGER
              : Date.now() + ChannelStore.channelTransactionClaimTtlMs,
          },
        }
      })
      .then((current) => {
        if (
          getConfirmation() &&
          current?.pendingCloseClaim?.id === claimId &&
          current.pendingCloseClaim.expiresAt === Number.MAX_SAFE_INTEGER
        )
          clearInterval(timer)
      })
      .catch(() => undefined)
  }, ChannelStore.channelTransactionClaimTtlMs / 3)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}

/**
 * Renews a top-up lease every third of its TTL while submission is pending.
 * Once confirmation is known, a successful renewal pins the lease and stops
 * the timer. Transient failures are ignored, the timer does not keep Node
 * alive, and the returned cleanup function stops further renewals.
 */
function maintainPendingTopUpClaim(parameters: {
  claimId: string
  channelId: Hex
  getConfirmation: () => { deposit: bigint; txHash: Hex } | undefined
  store: ChannelStore.ChannelStore
}): () => void {
  const { claimId, channelId, getConfirmation, store } = parameters
  const timer = setInterval(() => {
    void store
      .updateChannel(channelId, (current) => {
        if (!current || current.pendingTopUpClaim?.id !== claimId) return current
        const confirmation = getConfirmation()
        return {
          ...current,
          pendingTopUpClaim: {
            ...current.pendingTopUpClaim,
            ...(confirmation ?? {}),
            expiresAt: confirmation
              ? Number.MAX_SAFE_INTEGER
              : Date.now() + ChannelStore.channelTransactionClaimTtlMs,
          },
        }
      })
      .then((current) => {
        if (
          getConfirmation() &&
          current?.pendingTopUpClaim?.id === claimId &&
          current.pendingTopUpClaim.expiresAt === Number.MAX_SAFE_INTEGER
        )
          clearInterval(timer)
      })
      .catch(() => undefined)
  }, ChannelStore.channelTransactionClaimTtlMs / 3)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}
