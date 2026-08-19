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
import * as MachineTokenSession from '../../internal/machine-token-session.js'
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
import { getChallengePaymentFields, type ChallengePaymentFields } from './RequestState.js'
import {
  assertSettlementSender,
  getClientAccount,
  resolveChannelTransactionOptions,
  type OnSessionSettlement,
} from './Settlement.js'

/** Returns the effective voucher signer for a TIP-1034 descriptor. */
export function authorizedSigner(descriptor: Channel.ChannelDescriptor): Address {
  return isAddressEqual(descriptor.authorizedSigner, zeroAddress)
    ? descriptor.payer
    : descriptor.authorizedSigner
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

type ResolvedCredentialRoute = {
  allowedFeeTokens: readonly [Address]
  expectedOperator: Address
  machineRouter?: Address | undefined
  payment: ChallengePaymentFields
}

async function resolveCredentialRoute(parameters: {
  challenge: Challenge.Challenge
  chainId: number
  client: Chain.TransactionClient
  escrow: Address
  expectedOperator?: Address | undefined
  feeToken?: Address | undefined
  payload: SessionCredentialPayload
}): Promise<ResolvedCredentialRoute> {
  const { challenge, chainId, client, escrow, payload } = parameters
  const { descriptor } = payload
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  if (
    Channel.computeId({ ...descriptor, chainId, escrow }).toLowerCase() !== channelId.toLowerCase()
  )
    throw new VerificationFailedError({ reason: 'channel descriptor does not match channelId' })
  const request = getChallengePaymentFields(challenge)
  const expectedOperator = parameters.expectedOperator ?? zeroAddress
  const direct =
    isAddressEqual(descriptor.payee, request.recipient) &&
    isAddressEqual(descriptor.token, request.currency) &&
    isAddressEqual(descriptor.operator, expectedOperator)

  const allowedFeeTokens = (paymentToken: Address): readonly [Address] => [
    MachineTokenSession.resolveFeeToken({
      chainId,
      override: parameters.feeToken,
      paymentToken,
    }),
  ]
  if (direct)
    return {
      allowedFeeTokens: allowedFeeTokens(request.currency),
      expectedOperator,
      payment: request,
    }
  if (payload.action !== 'close' && !MachineTokenSession.isEnabledChallenge(challenge))
    throw new VerificationFailedError({ reason: 'credential descriptor does not match challenge' })

  const route = await MachineTokenSession.matchRoute(client, {
    active: payload.action !== 'close',
    chainId,
    descriptor,
    merchant: request.recipient,
    targetToken: request.currency,
  })
  if (!route)
    throw new VerificationFailedError({
      reason: 'machine-token channel is not bound to the challenged merchant and currency',
    })

  return {
    allowedFeeTokens: allowedFeeTokens(route.token),
    expectedOperator: route.operator,
    machineRouter: route.operator,
    payment: { ...request, currency: route.token, recipient: route.payee },
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

function readOptionalHex(value: unknown, field: string): Hex | undefined {
  return value === undefined ? undefined : readHex(value, field)
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
        authorizationSignature: readOptionalHex(
          candidate.authorizationSignature,
          'authorizationSignature',
        ),
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
        authorizationSignature: readOptionalHex(
          candidate.authorizationSignature,
          'authorizationSignature',
        ),
      }
    case 'close':
      return {
        action: 'close',
        channelId: header.channelId,
        descriptor: readDescriptor(candidate.descriptor),
        cumulativeAmount: readRawAmount(candidate.cumulativeAmount, 'cumulativeAmount'),
        signature: readHex(candidate.signature, 'signature'),
        authorizationSignature: readOptionalHex(
          candidate.authorizationSignature,
          'authorizationSignature',
        ),
        refundSignature: readOptionalHex(candidate.refundSignature, 'refundSignature'),
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
  /** Server-side channel store. */
  store: ChannelStore.ChannelStore
}

/** @deprecated Use {@link BroadcastCredentialPayloadParameters}. */
export type VerifyCredentialPayloadParameters = BroadcastCredentialPayloadParameters

/** Narrows shared credential broadcast inputs to one payload action. */
export type BroadcastCredentialActionParameters<action extends SessionCredentialPayload['action']> =
  Omit<BroadcastCredentialPayloadParameters, 'payload'> &
    ResolvedCredentialRoute & {
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
>

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
  const context = await resolveCredentialContext(parameters)
  switch (payload.action) {
    case 'open':
      await validateOpenCredential(context, payload)
      break
    case 'topUp':
      await validateTopUpCredential(context, payload)
      break
    case 'voucher':
      await validateVoucherCredential(context, payload)
      break
    case 'close':
      await validateCloseCredential(context, payload)
      break
  }
  return { action: payload.action, channelId: ChannelStore.normalizeChannelId(payload.channelId) }
}

async function validateOpenCredential(
  parameters: ValidateCredentialPayloadParameters & ResolvedCredentialRoute,
  payload: Extract<SessionCredentialPayload, { action: 'open' }>,
) {
  const { challenge, chainId, client, escrow, expectedOperator, payment: request } = parameters
  const cumulativeAmount = uint96(BigInt(payload.cumulativeAmount))
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
    allowedFeeTokens: parameters.allowedFeeTokens,
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
  parameters: ValidateCredentialPayloadParameters & ResolvedCredentialRoute,
  payload: Extract<SessionCredentialPayload, { action: 'topUp' }>,
) {
  const {
    challenge,
    chainId,
    client,
    escrow,
    expectedOperator,
    payment: request,
    store,
  } = parameters
  const additionalDeposit = uint96(BigInt(payload.additionalDeposit))
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
  const transaction = Chain.validateTopUpCredentialTransaction({
    additionalDeposit,
    allowedFeeTokens: parameters.allowedFeeTokens,
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
  validateChannelState(await Chain.getChannelState(client, channelId, escrow))
  await Chain.simulateCredentialTransaction({
    client,
    feePayer: parameters.feePayer,
    transaction: transaction.transaction,
  })
}

async function validateVoucherCredential(
  parameters: ValidateCredentialPayloadParameters & ResolvedCredentialRoute,
  payload: Extract<SessionCredentialPayload, { action: 'voucher' }>,
) {
  const {
    chainId,
    client,
    credentialSource,
    escrow,
    minVoucherDelta,
    store,
    channelStateTtl,
    lastOnChainVerified,
    payment: request,
  } = parameters
  const { expectedOperator } = parameters
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  const voucher = Voucher.parseVoucherFromPayload(
    channelId,
    payload.cumulativeAmount,
    payload.signature,
    payload.authorizationSignature,
  )
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
  const channelState = await resolveVoucherChannelState({
    channel,
    channelId,
    channelStateTtl,
    client,
    escrow,
    lastOnChainVerified,
  })
  await ChannelStore.validateVoucher({
    channel,
    channelState,
    methodDetails: { chainId, escrowContract: escrow },
    minVoucherDelta,
    voucher,
  })
}

async function resolveVoucherChannelState(parameters: {
  channel: ChannelStore.State
  channelId: Hex
  channelStateTtl: number
  client: Chain.TransactionClient
  escrow: Address
  lastOnChainVerified: Map<Hex, number>
}): Promise<Chain.ChannelState> {
  const { channel, channelId, channelStateTtl, client, escrow, lastOnChainVerified } = parameters
  const isStale = Date.now() - (lastOnChainVerified.get(channelId) ?? 0) > channelStateTtl
  const state = isStale ? await Chain.getChannelState(client, channelId, escrow) : undefined
  if (state) lastOnChainVerified.set(channelId, Date.now())
  return {
    deposit: state?.deposit ?? uint96(channel.deposit),
    settled: state?.settled ?? uint96(channel.settledOnChain),
    closeRequestedAt: state?.closeRequestedAt ?? Number(channel.closeRequestedAt),
  }
}

function verifyMachineSessionAuthorization(parameters: {
  chainId: number
  payload: SessionCredentialPayload
  router: Address | undefined
}): void {
  const { chainId, payload, router } = parameters
  if (payload.action === 'topUp') return undefined
  if (!router) return undefined
  // The escrow resolves a zero authorizedSigner to the payer, but the router
  // domain is bound to an explicit signer; reject the delegation up front
  // instead of failing signature verification against the zero address.
  if (isAddressEqual(payload.descriptor.authorizedSigner, zeroAddress))
    throw new VerificationFailedError({
      reason: 'machine-token sessions require an explicit authorizedSigner',
    })
  if (!payload.authorizationSignature)
    throw new VerificationFailedError({
      reason: 'machine-token voucher requires a router authorization',
    })
  const valid = MachineTokenSession.verifyAuthorization({
    authorization: {
      channelId: ChannelStore.normalizeChannelId(payload.channelId),
      cumulativeAmount: uint96(BigInt(payload.cumulativeAmount)),
    },
    chainId,
    expectedSigner: payload.descriptor.authorizedSigner,
    router,
    signature: payload.authorizationSignature,
  })
  if (!valid)
    throw new InvalidSignatureError({ reason: 'invalid machine-token router authorization' })
}

async function resolveCredentialContext<
  const parameters extends
    | BroadcastCredentialPayloadParameters
    | ValidateCredentialPayloadParameters,
>(parameters: parameters): Promise<parameters & ResolvedCredentialRoute> {
  const route = await resolveCredentialRoute(parameters)
  verifyMachineSessionAuthorization({
    chainId: parameters.chainId,
    payload: parameters.payload,
    router: route.machineRouter,
  })
  return { ...parameters, ...route }
}

function assertMachineCloseAmount(
  machineRouter: Address | undefined,
  cumulativeAmount: bigint,
  captureAmount: bigint,
) {
  if (machineRouter && cumulativeAmount !== captureAmount)
    throw new VerificationFailedError({
      reason: `machine-token close voucher amount must equal ${captureAmount} (capture amount)`,
    })
}

async function inspectCloseCredential(
  parameters: ValidateCredentialPayloadParameters & ResolvedCredentialRoute,
  payload: Extract<SessionCredentialPayload, { action: 'close' }>,
) {
  const {
    account: accountOverride,
    chainId,
    client,
    escrow,
    expectedOperator,
    machineRouter,
    payment,
    store,
  } = parameters
  const cumulativeAmount = uint96(BigInt(payload.cumulativeAmount))
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  validateChannelDescriptor(
    payload.descriptor,
    channelId,
    chainId,
    escrow,
    payment.recipient,
    payment.currency,
    expectedOperator,
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
  if (
    !(await Voucher.verifyVoucher(
      escrow,
      chainId,
      { channelId, cumulativeAmount, signature: payload.signature },
      channel.authorizedSigner,
    ))
  )
    throw new InvalidSignatureError({ reason: 'invalid voucher signature' })

  const refundSignature = machineRouter ? payload.refundSignature : undefined
  if (machineRouter) {
    if (!refundSignature)
      throw new VerificationFailedError({
        reason: 'machine-token close requires a refund authorization',
      })
    if (
      !(await Voucher.verifyVoucher(
        escrow,
        chainId,
        { channelId, cumulativeAmount: uint96(state.deposit), signature: refundSignature },
        payload.descriptor.authorizedSigner,
      ))
    )
      throw new InvalidSignatureError({ reason: 'invalid machine-token refund authorization' })
  }

  const captureAmount = uint96(channel.spent > state.settled ? channel.spent : state.settled)
  if (captureAmount > state.deposit)
    throw new AmountExceedsDepositError({ reason: 'close capture amount exceeds on-chain deposit' })
  assertMachineCloseAmount(machineRouter, cumulativeAmount, captureAmount)
  const account = accountOverride ?? getClientAccount(client)
  if (!machineRouter || !account)
    assertSettlementSender({
      operation: 'close',
      channelId,
      operator: channel.operator,
      payee: channel.payee,
      sender: account?.address,
    })
  return {
    account,
    authorizationSignature: machineRouter ? payload.authorizationSignature : undefined,
    captureAmount,
    channel,
    channelId,
    cumulativeAmount,
    refundSignature,
    state,
  }
}

async function validateCloseCredential(
  parameters: ValidateCredentialPayloadParameters & ResolvedCredentialRoute,
  payload: Extract<SessionCredentialPayload, { action: 'close' }>,
) {
  await inspectCloseCredential(parameters, payload)
}

/** Broadcasts a validated session credential payload and applies its state transition. */
export async function broadcastCredentialPayload(
  context: BroadcastCredentialPayloadParameters,
): Promise<SessionReceipt> {
  const receipt = await broadcastCredentialAction(await resolveCredentialContext(context))
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
  context: BroadcastCredentialPayloadParameters & ResolvedCredentialRoute,
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
  context: BroadcastCredentialPayloadParameters & ResolvedCredentialRoute,
  payload: Extract<SessionCredentialPayload, { action: action }>,
): BroadcastCredentialActionParameters<action> {
  return { ...context, payload }
}

async function handleOpenCredential(
  parameters: OpenCredentialActionParameters,
): Promise<SessionReceipt> {
  const {
    store,
    client,
    challenge,
    payload,
    chainId,
    escrow,
    expectedOperator,
    payment: request,
  } = parameters
  const cumulativeAmount = uint96(BigInt(payload.cumulativeAmount))
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
    allowedFeeTokens: parameters.allowedFeeTokens,
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
      authorizationSignature: payload.authorizationSignature,
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
  const {
    store,
    client,
    challenge,
    payload,
    chainId,
    escrow,
    expectedOperator,
    payment: request,
  } = parameters
  const additionalDeposit = uint96(BigInt(payload.additionalDeposit))
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
  const result = await Chain.broadcastTopUpTransaction({
    additionalDeposit,
    allowedFeeTokens: parameters.allowedFeeTokens,
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
    credentialSource,
    payload,
    chainId,
    escrow,
    minVoucherDelta,
    channelStateTtl,
    lastOnChainVerified,
    payment: request,
  } = parameters
  const { expectedOperator } = parameters
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  const voucher = Voucher.parseVoucherFromPayload(
    channelId,
    payload.cumulativeAmount,
    payload.signature,
    payload.authorizationSignature,
  )
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
  const channelState = await resolveVoucherChannelState({
    channel,
    channelId,
    channelStateTtl,
    client,
    escrow,
    lastOnChainVerified,
  })
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
  const { store, client, challenge, payload, escrow, machineRouter } = parameters
  const inspected = await inspectCloseCredential(parameters, payload)
  const {
    account,
    authorizationSignature,
    channel,
    channelId,
    cumulativeAmount,
    refundSignature,
    state,
  } = inspected
  let { captureAmount } = inspected
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
      assertMachineCloseAmount(machineRouter, cumulativeAmount, next.captureAmount)
      captureAmount = next.captureAmount
      pendingCloseMarked = true
    }
    return next.state
  })
  let txHash: Hex | undefined
  let receipt: Awaited<ReturnType<typeof Chain.waitForSuccessfulReceipt>>
  try {
    const transactionOptions = resolveChannelTransactionOptions(channel, parameters, account)
    if (machineRouter) {
      if (!authorizationSignature || !refundSignature)
        throw new VerificationFailedError({
          reason: 'machine-token close requires router and refund authorizations',
        })
      txHash = await Chain.closeMachineSessionOnChain(
        client,
        channel.descriptor,
        cumulativeAmount,
        payload.signature,
        authorizationSignature,
        refundSignature,
        machineRouter,
        transactionOptions,
      )
    } else {
      txHash = await Chain.closeOnChain(
        client,
        channel.descriptor,
        cumulativeAmount,
        captureAmount,
        payload.signature,
        escrow,
        transactionOptions,
      )
    }
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
  if (machineRouter) {
    if (settledToPayee !== state.deposit || refundedToPayer !== 0n)
      throw new VerificationFailedError({
        reason: 'machine-token ChannelClosed amounts are invalid',
      })
  } else if (settledToPayee > captureAmount || settledToPayee + refundedToPayer > state.deposit) {
    throw new VerificationFailedError({ reason: 'ChannelClosed amounts do not match state' })
  }
  const logicalSettled = machineRouter ? captureAmount : settledToPayee
  const updated = await store.updateChannel(channelId, (current) =>
    ChannelStore.finalizeClosedChannelState({
      authorizationSignature,
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
          amount: logicalSettled,
          delta: logicalSettled - state.settled,
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
}
