import {
  isAddress,
  parseUnits,
  type Account as ViemAccount,
  type Address,
  type Client,
  type Hex,
} from 'viem'

import type * as Challenge from '../../../Challenge.js'
import * as Constants from '../../../Constants.js'
import * as Account from '../../../viem/Account.js'
import * as z from '../../../zod.js'
import * as Chain from '../precompile/Chain.js'
import * as Channel from '../precompile/Channel.js'
import type { SessionCredentialPayload } from '../precompile/Protocol.js'
import type { SessionSnapshot } from '../Snapshot.js'
import {
  createClosePayload,
  createOpenPayload,
  createTopUpPayload,
  createVoucherPayload,
  isSameAddress,
  resolveAuthorizedSigner,
  resolveEscrow,
  type ChannelEntry,
} from './ChannelOps.js'
import { channelKey, entryKey, type ChannelSink } from './ChannelStore.js'
import { assertWithinMaxDeposit, resolveOpeningDeposit } from './Runtime.js'

/** Credential payload variants that carry cumulative voucher authorization. */
export type CumulativeCredentialPayload = Extract<
  SessionCredentialPayload,
  { cumulativeAmount: string }
>

/** Returns whether a credential payload carries cumulative voucher authorization. */
export function hasCredentialCumulativeAmount(
  payload: SessionCredentialPayload,
): payload is CumulativeCredentialPayload {
  return 'cumulativeAmount' in payload
}

/** Reads cumulative authorization from a credential payload when the action carries one. */
export function readCredentialCumulativeAmount(
  payload: SessionCredentialPayload,
): bigint | undefined {
  if (!hasCredentialCumulativeAmount(payload)) return undefined
  return BigInt(payload.cumulativeAmount)
}

/**
 * Persists a channel entry through the sink and notifies observers. Closed
 * channels are removed from the store but still reported to observers so callers
 * can react to the close.
 */
async function storeChannelEntry(sink: ChannelSink, entry: ChannelEntry): Promise<void> {
  if (entry.opened) await sink.store.set(entry)
  else await sink.store.delete(entryKey(entry))
  sink.notifyUpdate(entry)
}

/** Applies a credential payload's cumulative amount to the stored channel at `key`. */
async function applyCumulative(
  sink: ChannelSink,
  key: string,
  payload: SessionCredentialPayload,
): Promise<void> {
  const cumulativeAmount = readCredentialCumulativeAmount(payload)
  if (cumulativeAmount === undefined) return
  const entry = await sink.store.get(key)
  if (!entry) return
  entry.cumulativeAmount =
    entry.cumulativeAmount > cumulativeAmount ? entry.cumulativeAmount : cumulativeAmount
  if (payload.action === 'close') entry.opened = false
  await storeChannelEntry(sink, entry)
}

const hexSchema = z.custom<Hex>(
  (value) => typeof value === 'string' && /^0x[0-9a-fA-F]*$/.test(value),
)
const hashSchema = z.custom<Hex>(
  (value) => typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value),
)

/** Runtime schema for low-level TIP-1034 session credential context. */
export const sessionContextSchema = z.object({
  account: z.optional(z.custom<Account.getResolver.Parameters['account']>()),
  action: z.optional(z.enum(['open', 'topUp', 'voucher', 'close'])),
  channelId: z.optional(hashSchema),
  cumulativeAmount: z.optional(z.amount()),
  cumulativeAmountRaw: z.optional(z.string()),
  transaction: z.optional(hexSchema),
  descriptor: z.optional(z.custom<Channel.ChannelDescriptor>()),
  additionalDeposit: z.optional(z.amount()),
  additionalDepositRaw: z.optional(z.string()),
  depositRaw: z.optional(z.string()),
})

/** Low-level context accepted by `tempo.session()` for manual credentials. */
export type SessionContext = {
  /** Optional account override used for this credential only. */
  account?: Account.getResolver.Parameters['account'] | undefined
  /** Manual credential action. Omit for automatic open/recover/voucher management. */
  action?: 'open' | 'topUp' | 'voucher' | 'close' | undefined
  /** Channel ID being reused or manually operated on. */
  channelId?: Hex | undefined
  /** Human-readable cumulative voucher authorization, parsed with configured decimals. */
  cumulativeAmount?: string | undefined
  /** Raw cumulative voucher authorization. Takes precedence over `cumulativeAmount`. */
  cumulativeAmountRaw?: string | undefined
  /** Signed Tempo transaction for manual open/top-up credentials. */
  transaction?: Hex | undefined
  /** TIP-1034 descriptor required for recovery and manual credentials. */
  descriptor?: Channel.ChannelDescriptor | undefined
  /** Human-readable additional top-up deposit, parsed with configured decimals. */
  additionalDeposit?: string | undefined
  /** Raw additional top-up deposit. Takes precedence over `additionalDeposit`. */
  additionalDepositRaw?: string | undefined
  /** Raw opening deposit override for automatic open credentials. */
  depositRaw?: string | undefined
}

/** Manual low-level TIP-1034 session action name. */
export type SessionAction = NonNullable<SessionContext['action']>

/** Context amount fields that may be supplied as human-readable or raw token units. */
export type SessionAmountField = 'additionalDeposit' | 'cumulativeAmount'

/** Session context narrowed to an explicit manual action. */
export type ManualSessionContext = SessionContext & { action: SessionAction }

/** Manual session action context after the required channel descriptor is present. */
export type ManualSessionDescriptorContext = ManualSessionContext & {
  /** TIP-1034 channel descriptor used by manual open/top-up/voucher/close actions. */
  descriptor: Channel.ChannelDescriptor
}

/** Session context narrowed to a recoverable TIP-1034 channel descriptor. */
export type DescriptorSessionContext = SessionContext & { descriptor: Channel.ChannelDescriptor }

/** Returns whether a session context contains an explicit manual action. */
export function hasSessionAction(
  context: SessionContext | undefined,
): context is ManualSessionContext {
  return context?.action !== undefined
}

/** Returns whether a context is a manual action with the descriptor required to execute it. */
export function hasManualSessionDescriptor(
  context: SessionContext | undefined,
): context is ManualSessionDescriptorContext {
  return hasSessionAction(context) && context.descriptor !== undefined
}

/** Returns whether a session context contains a recoverable channel descriptor. */
export function hasSessionDescriptor(
  context: SessionContext | undefined,
): context is DescriptorSessionContext {
  return context?.descriptor !== undefined
}

/** Parses an optional session context amount, preferring the raw-unit field when present. */
export function parseOptionalContextAmount(
  context: SessionContext,
  decimals: number,
  field: SessionAmountField,
): bigint | undefined {
  const raw =
    field === 'additionalDeposit' ? context.additionalDepositRaw : context.cumulativeAmountRaw
  const amount =
    field === 'additionalDeposit' ? context.additionalDeposit : context.cumulativeAmount
  if (raw) return BigInt(raw)
  if (amount) return parseUnits(amount, decimals)
  return undefined
}

/** Parses a required session context amount and throws with action-specific context when absent. */
export function requireContextAmount(
  context: SessionContext,
  decimals: number,
  field: SessionAmountField,
  action: string,
): bigint {
  const amount = parseOptionalContextAmount(context, decimals, field)
  if (amount === undefined) throw new Error(`${field} required for ${action} action`)
  return amount
}

/** Tempo-specific details embedded in a `tempo/session` challenge request. */
export type ClientSessionMethodDetails = {
  /** Chain ID used for voucher domain and channel ID derivation. */
  chainId?: number | undefined
  /** Escrow contract address advertised by the server. */
  escrowContract?: Address | undefined
  /** Legacy escrow hint accepted during migration. */
  escrow?: Address | undefined
  /** Whether the challenge allows fee-sponsored open/top-up transactions. */
  feePayer?: boolean | undefined
  /** Channel operator address advertised by the server. */
  operator?: Address | undefined
  /** Server bootstrap snapshot for a reusable session channel. */
  sessionSnapshot?: SessionSnapshot | undefined
}

/** Dependencies used to resolve a challenge into typed credential-planning data. */
export type ResolveChallengeContextParameters = {
  /** Challenge received from the 402 response. */
  challenge: Challenge.Challenge
  /** Optional local escrow override. */
  escrowOverride?: Address | undefined
  /** Resolves the viem client for the challenge chain. */
  getClient(parameters: { chainId?: number | undefined }): Client | Promise<Client>
}

/** Reads TIP-1034 channel state for a recovery candidate. */
export type ReadReusableChannelState = (
  client: Client,
  channelId: Hex,
  escrow: Address,
) => Promise<Chain.ChannelState>

/** Expected request fields used to prove a descriptor belongs to the current challenge. */
export type ReusableChannelExpectation = {
  /** Chain ID used in the TIP-1034 channel ID derivation. */
  chainId: number
  /** Escrow precompile address used in the TIP-1034 channel ID derivation. */
  escrow: Address
  /** Payee expected by the current challenge. */
  payee: Address
  /** Payer address controlled by the local account. */
  payer: Address
  /** Voucher signer resolved from local account configuration. */
  authorizedSigner: Address
  /** Token expected by the current challenge. */
  token: Address
}

/** Inputs for validating and loading an existing precompile session channel. */
export type ResolveReusableChannelParameters = {
  /** Optional caller/server supplied channel ID. Must match the descriptor-derived ID. */
  channelId?: string | undefined
  /** Viem client used to read on-chain channel state. */
  client: Client
  /** Descriptor required by TIP-1034 vouchers and management transactions. */
  descriptor: Channel.ChannelDescriptor
  /** Expected challenge fields the descriptor must match. */
  expected: ReusableChannelExpectation
  /** Optional state reader for tests or custom clients. Defaults to `Chain.getChannelState`. */
  readChannelState?: ReadReusableChannelState | undefined
}

/** Validated reusable channel data. */
export type ReusableChannel = {
  /** Descriptor-derived TIP-1034 channel ID. */
  channelId: Hex
  /** On-chain channel state proving the channel is open and reusable. */
  state: Chain.ChannelState
}

/** Resolved payment challenge fields used to plan a client-side session credential. */
export type ChallengeContext = {
  amount: bigint
  challenge: Challenge.Challenge
  chainId: number
  client: Client
  escrow: Address
  feePayer?: boolean | undefined
  key: string
  operator?: Address | undefined
  payee: Address
  snapshot?: SessionSnapshot | undefined
  /** Server-provided raw deposit hint for opening a channel, before local maxDeposit capping. */
  suggestedDepositRaw?: string | undefined
  token: Address
}

/** Inputs used to choose the next client-side session credential operation. */
export type PlanCredentialParameters = {
  account: ViemAccount
  authorizedSigner?: Address | undefined
  /** Channel previously stored for this challenge scope, fetched by the caller. */
  entry: ChannelEntry | undefined
  context?: SessionContext | undefined
  decimals: number
  maxDeposit?: bigint | undefined
  resolved: ChallengeContext
}

/** Inputs used to derive reusable-channel recovery context from caller context and server hints. */
export type ResolveRecoverContextParameters = {
  /** Caller-provided low-level session context, when present. */
  context?: SessionContext | undefined
  /** Server-provided session snapshot, when present. */
  snapshot?: SessionSnapshot | undefined
}

/** Inputs used to choose the next cumulative authorization for a recovered channel. */
export type ResolveRecoveredCumulativeParameters = {
  /** Caller or stored-channel recovery context. */
  context: DescriptorSessionContext
  /** Token decimals used to parse human-readable context amounts. */
  decimals: number
  /** Current request amount from the active challenge. */
  requestAmount: bigint
  /** Server snapshot for the recovered channel, when present. */
  snapshot?: SessionSnapshot | undefined
  /** On-chain settled amount used when no local/server accounting is available. */
  settled: bigint
}

/** Data-first description of the next credential operation the client should execute. */
export type CredentialPlan =
  /** No reusable channel is available, so create an open transaction and initial voucher. */
  | {
      type: 'open'
      account: ViemAccount
      authorizedSigner?: Address | undefined
      context?: SessionContext | undefined
      maxDeposit?: bigint | undefined
      resolved: ChallengeContext
    }
  /** Rehydrate a known channel from server snapshot or caller descriptor before signing. */
  | {
      type: 'recover'
      account: ViemAccount
      authorizedSigner?: Address | undefined
      context: DescriptorSessionContext
      decimals: number
      maxDeposit?: bigint | undefined
      resolved: ChallengeContext
    }
  /** Reuse an active cached channel by increasing the cumulative voucher amount. */
  | {
      type: 'voucher'
      account: ViemAccount
      entry: ChannelEntry
      maxDeposit?: bigint | undefined
      resolved: ChallengeContext
    }
  /** Caller supplied an explicit low-level action such as top-up, voucher, or close. */
  | {
      type: 'manual'
      account: ViemAccount
      authorizedSigner?: Address | undefined
      context: ManualSessionDescriptorContext
      decimals: number
      resolved: ChallengeContext
    }

type ManualCredentialParameters = Pick<
  Extract<CredentialPlan, { type: 'manual' }>,
  'account' | 'context' | 'decimals' | 'resolved'
> & {
  channelId: Hex
  descriptor: Channel.ChannelDescriptor
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function readOptionalAddress(value: unknown): Address | undefined {
  return typeof value === 'string' && isAddress(value, { strict: false }) ? value : undefined
}

function readMethodDetails(challenge: Challenge.Challenge): ClientSessionMethodDetails {
  const methodDetails = challenge.request.methodDetails
  if (!isObject(methodDetails)) return {}
  return {
    chainId: typeof methodDetails.chainId === 'number' ? methodDetails.chainId : undefined,
    escrowContract: readOptionalAddress(methodDetails.escrowContract),
    escrow: readOptionalAddress(methodDetails.escrow),
    feePayer: typeof methodDetails.feePayer === 'boolean' ? methodDetails.feePayer : undefined,
    operator: readOptionalAddress(methodDetails.operator),
    sessionSnapshot: Constants.getMethodDetail<SessionSnapshot>(
      methodDetails,
      Constants.MethodDetailKeys.sessionSnapshot,
    ),
  }
}

function readAddress(value: unknown, label: string): Address {
  if (typeof value === 'string' && isAddress(value, { strict: false })) return value
  throw new Error(`tempo session challenge missing ${label}`)
}

function readAmount(value: unknown): bigint {
  if (typeof value === 'string') return BigInt(value)
  throw new Error('tempo session challenge missing amount')
}

function readSuggestedDeposit(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined
}

/** Resolves raw challenge fields into the typed data required by client credential planning. */
export async function resolveChallengeContext(
  parameters: ResolveChallengeContextParameters,
): Promise<ChallengeContext> {
  const { challenge, escrowOverride, getClient } = parameters
  const methodDetails = readMethodDetails(challenge)
  const client = await getClient({ chainId: methodDetails.chainId })
  const chainId = methodDetails.chainId ?? client.chain?.id
  if (!chainId) throw new Error('No chainId configured for TIP-1034 session challenge.')

  const escrow = resolveEscrow(challenge, escrowOverride)
  const payee = readAddress(challenge.request.recipient, 'recipient')
  const token = readAddress(challenge.request.currency, 'currency')

  return {
    amount: readAmount(challenge.request.amount),
    challenge,
    chainId,
    client,
    escrow,
    feePayer: methodDetails.feePayer,
    key: channelKey({ payee, token, escrow, chainId }),
    operator: methodDetails.operator,
    payee,
    snapshot: methodDetails.sessionSnapshot,
    suggestedDepositRaw: readSuggestedDeposit(challenge.request.suggestedDeposit),
    token,
  }
}

/** Validates descriptor identity and reads open channel state for client-side recovery. */
export async function resolveReusableChannel(
  parameters: ResolveReusableChannelParameters,
): Promise<ReusableChannel> {
  const {
    channelId,
    client,
    descriptor,
    expected,
    readChannelState = Chain.getChannelState,
  } = parameters
  const expectedChannelId = Channel.computeId({
    ...descriptor,
    chainId: expected.chainId,
    escrow: expected.escrow,
  })

  assertReusableChannelDescriptor({
    channelId,
    descriptor,
    expectedChannelId,
    payee: expected.payee,
    payer: expected.payer,
    authorizedSigner: expected.authorizedSigner,
    token: expected.token,
  })

  const state = await readChannelState(client, expectedChannelId, expected.escrow)
  if (state.deposit === 0n)
    throw new Error(`Channel ${expectedChannelId} cannot be reused (closed or not found on-chain).`)
  if (state.closeRequestedAt !== 0)
    throw new Error(`Channel ${expectedChannelId} cannot be reused (pending close request).`)

  return { channelId: expectedChannelId, state }
}

function assertReusableChannelDescriptor(parameters: {
  channelId?: string | undefined
  descriptor: Channel.ChannelDescriptor
  expectedChannelId: string
  payee: Address
  payer: Address
  authorizedSigner: Address
  token: Address
}) {
  const { authorizedSigner, channelId, descriptor, expectedChannelId, payee, payer, token } =
    parameters
  if (channelId && channelId.toLowerCase() !== expectedChannelId.toLowerCase())
    throw new Error('context channelId does not match descriptor')
  if (!isSameAddress(descriptor.payee, payee))
    throw new Error('context descriptor payee does not match challenge')
  if (!isSameAddress(descriptor.token, token))
    throw new Error('context descriptor token does not match challenge')
  if (!isSameAddress(descriptor.payer, payer))
    throw new Error('context descriptor payer does not match account')
  if (!isSameAddress(descriptor.authorizedSigner, authorizedSigner))
    throw new Error('context descriptor authorizedSigner does not match account')
}

/** Resolves descriptor-based recovery data, preferring caller context over server hints. */
export function resolveRecoverContext(
  parameters: ResolveRecoverContextParameters,
): DescriptorSessionContext | undefined {
  const { context, snapshot } = parameters
  const descriptor = context?.descriptor ?? snapshot?.descriptor
  if (!descriptor) return undefined
  return {
    ...context,
    channelId: context?.channelId ?? snapshot?.channelId,
    descriptor,
  }
}

/** Resolves a voucher boundary that can satisfy the resumed request. */
export function resolveRecoveredCumulative(
  parameters: ResolveRecoveredCumulativeParameters,
): bigint {
  const { context, decimals, requestAmount, snapshot, settled } = parameters

  if (snapshot) {
    return BigInt(snapshot.spent) + requestAmount
  }

  const contextCumulative = parseOptionalContextAmount(context, decimals, 'cumulativeAmount')
  if (contextCumulative !== undefined) return contextCumulative + requestAmount
  return settled + requestAmount
}

/**
 * Whether `account` can produce the voucher signer a descriptor was opened with.
 * Root-signed channels (zero or payer `authorizedSigner`) require the root
 * account; access-key-signed channels require the account whose delegated signer
 * matches. Used to gate automatic resume/recover: a stored entry or server
 * snapshot the local account can no longer sign for is dropped in favor of a
 * fresh open, rather than producing a voucher the escrow would reject.
 */
export function canSignDescriptor(
  account: ViemAccount,
  descriptor: Channel.ChannelDescriptor,
  authorizedSigner?: Address | undefined,
): boolean {
  // Only the payer can deposit into and voucher against its own channel,
  // regardless of who the voucher signer is.
  if (!isSameAddress(account.address, descriptor.payer)) return false
  const signer = descriptor.authorizedSigner
  // Root-signed channels (zero or payer signer) are signable now that the payer
  // matches; access-key-signed channels also require the delegated signer.
  if (BigInt(signer) === 0n || isSameAddress(signer, descriptor.payer)) return true
  return isSameAddress(resolveAuthorizedSigner(account, authorizedSigner), signer)
}

/** Chooses the next credential plan from local channel cache and optional caller context. */
export function planCredential(parameters: PlanCredentialParameters): CredentialPlan {
  const { account, authorizedSigner, entry, context, decimals, maxDeposit, resolved } = parameters

  if (hasSessionAction(context)) {
    if (!hasManualSessionDescriptor(context))
      throw new Error('descriptor required for TIP-1034 session action')
    return {
      type: 'manual',
      account,
      authorizedSigner,
      context,
      decimals,
      resolved,
    }
  }

  if (!entry && context?.channelId && !context.descriptor)
    throw new Error('descriptor required to reuse TIP-1034 channel')
  const recoverContext = resolveRecoverContext({ context, snapshot: resolved.snapshot })
  if (
    !entry &&
    recoverContext &&
    canSignDescriptor(account, recoverContext.descriptor, authorizedSigner)
  ) {
    return {
      type: 'recover',
      account,
      authorizedSigner,
      context: recoverContext,
      decimals,
      maxDeposit,
      resolved,
    }
  }
  if (entry?.opened && canSignDescriptor(account, entry.descriptor, authorizedSigner))
    return { type: 'voucher', account, entry, maxDeposit, resolved }
  return { type: 'open', account, authorizedSigner, context, maxDeposit, resolved }
}

/** Executes a credential plan and returns the concrete session credential payload. */
export async function executeCredentialPlan(
  plan: CredentialPlan,
  sink: ChannelSink,
): Promise<SessionCredentialPayload> {
  switch (plan.type) {
    case 'open':
      return open(plan, sink)
    case 'recover':
      return recover(plan, sink)
    case 'voucher':
      return voucher(plan, sink)
    case 'manual':
      return manual(plan, sink)
  }
}

async function open(
  plan: Extract<CredentialPlan, { type: 'open' }>,
  sink: ChannelSink,
): Promise<SessionCredentialPayload> {
  const { account, authorizedSigner, resolved } = plan
  const deposit = resolveOpeningDeposit({
    contextDepositRaw: plan.context?.depositRaw,
    maxDeposit: plan.maxDeposit,
    requestAmount: resolved.amount,
    suggestedDepositRaw: resolved.suggestedDepositRaw,
  })
  const payload = await createOpenPayload(resolved.client, account, {
    authorizedSigner,
    chainId: resolved.chainId,
    deposit,
    escrow: resolved.escrow,
    feePayer: resolved.feePayer,
    initialAmount: resolved.amount,
    operator: resolved.operator,
    payee: resolved.payee,
    token: resolved.token,
  })
  await storeChannelEntry(sink, {
    channelId: payload.channelId,
    cumulativeAmount: resolved.amount,
    deposit,
    descriptor: payload.descriptor,
    escrow: resolved.escrow,
    chainId: resolved.chainId,
    opened: true,
  })
  return payload
}

async function recover(
  plan: Extract<CredentialPlan, { type: 'recover' }>,
  sink: ChannelSink,
): Promise<SessionCredentialPayload> {
  const { account, context, decimals, maxDeposit, resolved } = plan
  const { descriptor } = context
  const reusable = await resolveReusableChannel({
    channelId: context.channelId,
    client: resolved.client,
    descriptor,
    expected: {
      chainId: resolved.chainId,
      escrow: resolved.escrow,
      payee: resolved.payee,
      payer: account.address,
      authorizedSigner: resolveAuthorizedSigner(account, plan.authorizedSigner),
      token: resolved.token,
    },
  })
  const cumulativeAmount = resolveRecoveredCumulative({
    context,
    decimals,
    requestAmount: resolved.amount,
    settled: reusable.state.settled,
    snapshot: resolved.snapshot,
  })
  if (cumulativeAmount > reusable.state.deposit)
    throw new Error('recovered voucher amount exceeds on-chain channel deposit')
  assertWithinMaxDeposit(cumulativeAmount, maxDeposit)
  const payload = await createVoucherPayload(
    resolved.client,
    account,
    descriptor,
    cumulativeAmount,
    resolved.chainId,
    resolved.escrow,
  )
  await storeChannelEntry(sink, {
    channelId: reusable.channelId,
    cumulativeAmount,
    deposit: reusable.state.deposit,
    descriptor,
    escrow: resolved.escrow,
    chainId: resolved.chainId,
    opened: true,
  })
  return payload
}

async function voucher(
  plan: Extract<CredentialPlan, { type: 'voucher' }>,
  sink: ChannelSink,
): Promise<SessionCredentialPayload> {
  const { account, entry, resolved } = plan
  const cumulativeAmount = entry.cumulativeAmount + resolved.amount
  assertWithinMaxDeposit(cumulativeAmount, plan.maxDeposit)
  const payload = await createVoucherPayload(
    resolved.client,
    account,
    entry.descriptor,
    cumulativeAmount,
    resolved.chainId,
    resolved.escrow,
  )
  entry.cumulativeAmount = cumulativeAmount
  await storeChannelEntry(sink, entry)
  return payload
}

async function manual(
  plan: Extract<CredentialPlan, { type: 'manual' }>,
  sink: ChannelSink,
): Promise<SessionCredentialPayload> {
  const { account, context, decimals, resolved } = plan
  const { descriptor } = context
  const channelId = Channel.computeId({
    ...descriptor,
    chainId: resolved.chainId,
    escrow: resolved.escrow,
  })
  assertReusableChannelDescriptor({
    channelId: context.channelId,
    descriptor,
    expectedChannelId: channelId,
    payee: resolved.payee,
    payer: account.address,
    authorizedSigner: resolveAuthorizedSigner(account, plan.authorizedSigner),
    token: resolved.token,
  })

  const payload = await executeManualCredential({
    account,
    channelId,
    context,
    decimals,
    descriptor,
    resolved,
  })
  await applyCumulative(sink, resolved.key, payload)
  return payload
}

async function executeManualCredential(
  parameters: ManualCredentialParameters,
): Promise<SessionCredentialPayload> {
  switch (parameters.context.action) {
    case 'open':
      return manualOpen(parameters)
    case 'topUp':
      return manualTopUp(parameters)
    case 'voucher':
      return manualVoucher(parameters)
    case 'close':
      return manualClose(parameters)
  }
}

async function manualOpen(
  parameters: ManualCredentialParameters,
): Promise<SessionCredentialPayload> {
  const { account, channelId, context, decimals, descriptor, resolved } = parameters
  if (!context.transaction) throw new Error('transaction required for open action')
  const cumulativeAmount = requireContextAmount(context, decimals, 'cumulativeAmount', 'open')
  const voucher = await createVoucherPayload(
    resolved.client,
    account,
    descriptor,
    cumulativeAmount,
    resolved.chainId,
    resolved.escrow,
  )
  return {
    action: 'open',
    type: 'transaction',
    channelId,
    transaction: context.transaction,
    signature: voucher.signature,
    descriptor,
    cumulativeAmount: cumulativeAmount.toString(),
    authorizedSigner: descriptor.authorizedSigner,
  }
}

async function manualTopUp(
  parameters: ManualCredentialParameters,
): Promise<SessionCredentialPayload> {
  const { account, channelId, context, decimals, descriptor, resolved } = parameters
  const additionalDeposit = requireContextAmount(context, decimals, 'additionalDeposit', 'topUp')
  if (context.transaction) {
    return {
      action: 'topUp',
      type: 'transaction',
      channelId,
      transaction: context.transaction,
      descriptor,
      additionalDeposit: additionalDeposit.toString(),
    }
  }
  return createTopUpPayload(
    resolved.client,
    account,
    descriptor,
    additionalDeposit,
    resolved.chainId,
    resolved.feePayer,
    resolved.escrow,
  )
}

function manualVoucher(parameters: ManualCredentialParameters): Promise<SessionCredentialPayload> {
  const { account, context, decimals, descriptor, resolved } = parameters
  return createVoucherPayload(
    resolved.client,
    account,
    descriptor,
    requireContextAmount(context, decimals, 'cumulativeAmount', 'voucher'),
    resolved.chainId,
    resolved.escrow,
  )
}

function manualClose(parameters: ManualCredentialParameters): Promise<SessionCredentialPayload> {
  const { account, context, decimals, descriptor, resolved } = parameters
  return createClosePayload(
    resolved.client,
    account,
    descriptor,
    requireContextAmount(context, decimals, 'cumulativeAmount', 'close'),
    resolved.chainId,
    resolved.escrow,
  )
}
