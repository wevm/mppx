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
} from '../precompile/Protocol.js'
import * as Voucher from '../precompile/Voucher.js'
import * as ChannelStore from './ChannelStore.js'
import { getChallengePaymentFields } from './RequestState.js'
import { assertSettlementSender, getClientAccount } from './Settlement.js'

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
      }
  }
}

function readTransactionType(value: unknown): 'transaction' {
  if (value === 'transaction') return value
  throw new VerificationFailedError({ reason: 'invalid session credential transaction type' })
}

/** Shared inputs required to verify a single precompile session credential payload. */
export type VerifyCredentialPayloadParameters = {
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
  /** TIP20EscrowChannel precompile address for this session method. */
  escrow: Address
  /** Optional fee-payer account for fee-sponsored management transactions. */
  feePayer?: viem_Account | undefined
  /** Optional policy for fee-sponsored close/open/top-up transactions. */
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
  /** Optional fee token override for close transactions. */
  feeToken?: Address | undefined
  /** Last successful on-chain refresh timestamp per channel ID. */
  lastOnChainVerified: Map<Hex, number>
  /** Minimum allowed voucher delta in raw units. */
  minVoucherDelta: bigint
  /** Discriminated session credential payload to verify. */
  payload: SessionCredentialPayload
  /** Server-side channel store. */
  store: ChannelStore.ChannelStore
}

/** Narrows shared credential verification inputs to one payload action. */
export type VerifyCredentialActionParameters<action extends SessionCredentialPayload['action']> =
  Omit<VerifyCredentialPayloadParameters, 'payload'> & {
    /** Credential payload for the selected action. */
    payload: Extract<SessionCredentialPayload, { action: action }>
  }

/** Inputs for verifying an open transaction credential and initial voucher. */
export type OpenCredentialActionParameters = VerifyCredentialActionParameters<'open'>

/** Inputs for verifying a top-up transaction credential. */
export type TopUpCredentialActionParameters = VerifyCredentialActionParameters<'topUp'>

/** Inputs for verifying and accepting an incremental voucher credential. */
export type VoucherCredentialActionParameters = VerifyCredentialActionParameters<'voucher'>

/** Inputs for verifying and settling a cooperative close credential. */
export type CloseCredentialActionParameters = VerifyCredentialActionParameters<'close'>

const refreshOnChainVerificationCache = {
  close: false,
  open: true,
  topUp: true,
  voucher: false,
} satisfies Record<SessionCredentialPayload['action'], boolean>

/** Verifies a session credential payload and applies the action-specific state transition. */
export async function verifyCredentialPayload(
  context: VerifyCredentialPayloadParameters,
): Promise<SessionReceipt> {
  const receipt = await verifyCredentialAction(context)
  if (refreshOnChainVerificationCache[context.payload.action])
    context.lastOnChainVerified.set(receipt.channelId, Date.now())
  return receipt
}

function verifyCredentialAction(
  context: VerifyCredentialPayloadParameters,
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
  context: VerifyCredentialPayloadParameters,
  payload: Extract<SessionCredentialPayload, { action: action }>,
): VerifyCredentialActionParameters<action> {
  return { ...context, payload }
}

async function handleOpenCredential(
  parameters: OpenCredentialActionParameters,
): Promise<SessionReceipt> {
  const { store, client, challenge, payload, chainId, escrow } = parameters
  const request = getChallengePaymentFields(challenge)
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
  )

  const result = await Chain.broadcastOpenTransaction({
    challengeExpires: challenge.expires,
    chainId,
    client,
    escrowContract: escrow,
    expectedAuthorizedSigner: payload.descriptor.authorizedSigner,
    expectedChannelId: channelId,
    expectedCurrency: request.currency,
    expectedOperator: payload.descriptor.operator,
    expectedPayee: request.recipient,
    expectedExpiringNonceHash: payload.descriptor.expiringNonceHash,
    expectedPayer: payload.descriptor.payer,
    feePayer: parameters.feePayer,
    feePayerPolicy: parameters.feePayerPolicy,
    serializedTransaction: payload.transaction,
    async beforeBroadcast(prepared) {
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

  const updated = await store.updateChannel(channelId, (current) =>
    ChannelStore.openChannelState({
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
    }),
  )
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
  )
  const channel = await ChannelStore.loadPrecompileChannel({
    descriptor: payload.descriptor,
    channelId,
    chainId,
    escrow,
    store,
    validateDescriptor: true,
  })
  const result = await Chain.broadcastTopUpTransaction({
    additionalDeposit,
    challengeExpires: challenge.expires,
    chainId,
    client,
    descriptor: channel.descriptor,
    escrowContract: escrow,
    expectedChannelId: channelId,
    expectedCurrency: request.currency,
    feePayer: parameters.feePayer,
    feePayerPolicy: parameters.feePayerPolicy,
    serializedTransaction: payload.transaction,
  })
  const { state } = result
  validateChannelState(state)

  const updated = await store.updateChannel(channelId, (current) =>
    ChannelStore.topUpChannelState({ current, state }),
  )
  return createSessionReceipt({
    challengeId: challenge.id,
    channelId,
    acceptedCumulative: updated?.highestVoucherAmount ?? channel.highestVoucherAmount,
    spent: updated?.spent ?? channel.spent,
    units: updated?.units ?? channel.units,
    txHash: result.txHash,
  })
}

async function handleVoucherCredential(
  parameters: VoucherCredentialActionParameters,
): Promise<SessionReceipt> {
  const {
    store,
    client,
    challenge,
    payload,
    chainId,
    escrow,
    minVoucherDelta,
    channelStateTtl,
    lastOnChainVerified,
  } = parameters
  const request = getChallengePaymentFields(challenge)
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
  )
  const channel = await ChannelStore.loadPrecompileChannel({
    descriptor: payload.descriptor,
    channelId,
    chainId,
    escrow,
    store,
    validateDescriptor: true,
  })
  if (channel.finalized) throw new ChannelClosedError({ reason: 'channel is finalized' })
  const isStale = Date.now() - (lastOnChainVerified.get(channelId) ?? 0) > channelStateTtl
  const state = isStale ? await Chain.getChannelState(client, channelId, escrow) : undefined
  if (state) lastOnChainVerified.set(channelId, Date.now())
  const channelState = {
    deposit: state?.deposit ?? uint96(channel.deposit),
    settled: state?.settled ?? uint96(channel.settledOnChain),
    closeRequestedAt: state?.closeRequestedAt ?? Number(channel.closeRequestedAt),
  }
  if (channelState.closeRequestedAt !== 0) {
    await store.updateChannel(channelId, (current) =>
      current
        ? {
            ...current,
            closeRequestedAt:
              BigInt(channelState.closeRequestedAt) > current.closeRequestedAt
                ? BigInt(channelState.closeRequestedAt)
                : current.closeRequestedAt,
          }
        : current,
    )
  }
  return ChannelStore.verifyAndAcceptVoucher({
    store,
    minVoucherDelta,
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
  )
  const channel = await ChannelStore.loadPrecompileChannel({
    descriptor: payload.descriptor,
    channelId,
    chainId,
    escrow,
    store,
  })
  if (channel.finalized) throw new ChannelClosedError({ reason: 'channel is already finalized' })
  const state = await Chain.getChannelState(client, channelId, escrow)
  if (state.closeRequestedAt !== 0)
    throw new ChannelClosedError({ reason: 'channel has a pending close request' })
  if (state.deposit === 0n && (cumulativeAmount !== 0n || channel.spent !== 0n))
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
  if (captureAmount > state.deposit)
    throw new AmountExceedsDepositError({ reason: 'close capture amount exceeds on-chain deposit' })
  const pendingCloseStartedAt = BigInt(Math.floor(Date.now() / 1000) || 1)
  const previousCloseRequestedAt = channel.closeRequestedAt
  let pendingCloseMarked = false
  await store.updateChannel(channelId, (current) => {
    const next = ChannelStore.markPendingClose({
      closeRequestedAt: pendingCloseStartedAt,
      cumulativeAmount,
      current,
      onChainDeposit: state.deposit,
      onChainSettled: state.settled,
    })
    if (next.state) {
      captureAmount = next.captureAmount
      pendingCloseMarked = true
    }
    return next.state
  })
  const account = parameters.account ?? getClientAccount(client)
  let txHash: Hex | undefined
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
          }
        : undefined,
    )
    receipt = await Chain.waitForSuccessfulReceipt(client, txHash)
  } catch (error) {
    if (pendingCloseMarked) {
      await store.updateChannel(channelId, (current) =>
        current && current.closeRequestedAt === pendingCloseStartedAt
          ? { ...current, closeRequestedAt: previousCloseRequestedAt }
          : current,
      )
    }
    throw error
  }
  const closed = readChannelClosedReceiptFields(
    Chain.getChannelEvent(receipt, 'ChannelClosed', channelId),
  )
  const { refundedToPayer, settledToPayee } = closed
  if (settledToPayee > captureAmount || settledToPayee + refundedToPayer > state.deposit)
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
  return createSessionReceipt({
    challengeId: challenge.id,
    channelId,
    acceptedCumulative: cumulativeAmount,
    spent: updated?.spent ?? channel.spent,
    units: updated?.units ?? channel.units,
    txHash,
  })
}
