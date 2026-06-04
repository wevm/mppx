import { parseUnits, type Hex } from 'viem'

import type {
  ChannelDescriptor,
  NeedVoucherEvent,
  RawAmountString,
  SessionCredentialPayload,
  SessionReceipt,
} from '../precompile/Protocol.js'
import * as Ws from '../precompile/Protocol.js'
import type { ChannelEntry } from './ChannelOps.js'
import type { SessionContext } from './CredentialState.js'
import type { TempoSessionChallenge } from './Transports.js'
import type { ActiveSocketSession } from './Transports.js'

/** Server-provided reusable channel state used to bootstrap a client session. */
export type SessionSnapshot = {
  /** Highest cumulative voucher amount the server has accepted for this channel. */
  acceptedCumulative: RawAmountString
  /** TIP-1034 channel ID derived from descriptor, escrow address, and chain ID. */
  channelId: Hex
  /** Timestamp when unilateral close was requested, when the channel is closing. */
  closeRequestedAt?: RawAmountString | undefined
  /** Current on-chain deposit ceiling for cumulative voucher authorization. */
  deposit: RawAmountString
  /** Full descriptor needed to recover the channel without client-side persistence. */
  descriptor: ChannelDescriptor
  /** Minimum cumulative authorization needed for the challenged request or stream continuation. */
  requiredCumulative: RawAmountString
  /** Amount already settled on-chain. */
  settled: RawAmountString
  /** Amount consumed by delivered content according to server accounting. */
  spent: RawAmountString
  /** Paid units delivered by the server, when the transport reports them. */
  units?: number | undefined
}

/** Initial manager state before a session challenge is observed. */
export type IdleSessionState = { status: 'idle' }

/** State after a tempo/session challenge has been selected but before a credential is created. */
export type ChallengedSessionState = { status: 'challenged'; challengeId: string }

/** State while a server snapshot is being used to hydrate a reusable channel. */
export type HydratingSessionState = {
  status: 'hydrating'
  challengeId: string
  snapshot: SessionSnapshot
}

/** State while the client is creating or submitting an opening channel credential. */
export type OpeningSessionState = { status: 'opening'; challengeId: string }

/** Active state variant used after a channel is opened, hydrated, or receives a receipt. */
export type ActiveSessionState = {
  status: 'active'
  challengeId: string
  channelId: Hex
  descriptor: ChannelDescriptor
  /** Highest cumulative voucher amount accepted by the server. */
  acceptedCumulative: RawAmountString
  /** Current channel deposit ceiling, tracked independently from accepted cumulative spend. */
  deposit: RawAmountString
  /** Amount actually consumed by delivered work/content. */
  spent: RawAmountString
  /** Paid units delivered by the server. */
  units: number
}

/** State when the server needs a larger cumulative voucher but no top-up is needed. */
export type VoucherNeededSessionState = {
  status: 'voucherNeeded'
  challengeId: string
  channelId: Hex
  descriptor: ChannelDescriptor
  requiredCumulative: RawAmountString
  deposit: RawAmountString
}

/** State when the server-required cumulative amount exceeds current channel deposit. */
export type ToppingUpSessionState = {
  status: 'toppingUp'
  challengeId: string
  channelId: Hex
  descriptor: ChannelDescriptor
  deposit: RawAmountString
}

/** State while the server is settling accepted voucher spend on-chain. */
export type SettlingSessionState = {
  status: 'settling'
  channelId: Hex
  descriptor: ChannelDescriptor
  deposit: RawAmountString
}

/** State after unilateral close has been requested and withdrawal is not yet available. */
export type CloseRequestedSessionState = {
  status: 'closeRequested'
  channelId: Hex
  descriptor: ChannelDescriptor
}

/** State after the unilateral close delay has elapsed and funds can be withdrawn. */
export type WithdrawableSessionState = {
  status: 'withdrawable'
  channelId: Hex
  descriptor: ChannelDescriptor
}

/** State while a cooperative close credential or close transaction is in flight. */
export type ClosingSessionState = {
  status: 'closing'
  channelId: Hex
  descriptor: ChannelDescriptor
}

/** Terminal state after channel close finalization. */
export type ClosedSessionState = {
  status: 'closed'
  channelId: Hex
  descriptor: ChannelDescriptor
}

/** Pure state-machine state for a TIP-1034 session. */
export type SessionState =
  | IdleSessionState
  | ChallengedSessionState
  | HydratingSessionState
  | OpeningSessionState
  | ActiveSessionState
  | VoucherNeededSessionState
  | ToppingUpSessionState
  | SettlingSessionState
  | CloseRequestedSessionState
  | WithdrawableSessionState
  | ClosingSessionState
  | ClosedSessionState

/** Data required to construct active session state. */
export type CreateActiveStateParameters = Omit<ActiveSessionState, 'status'>

/** State variants that can follow a need-voucher event. */
export type NeedVoucherSessionState = VoucherNeededSessionState | ToppingUpSessionState

/** Events accepted by the pure session reducer. */
export type SessionEvent =
  | { type: 'challenge'; challengeId: string; snapshot?: SessionSnapshot | undefined }
  | {
      type: 'opened'
      receipt: SessionReceipt
      descriptor: ChannelDescriptor
      deposit: RawAmountString
    }
  | { type: 'hydrated'; snapshot: SessionSnapshot }
  | { type: 'needVoucher'; event: NeedVoucherEvent; descriptor: ChannelDescriptor }
  | { type: 'topUpStarted' }
  | { type: 'voucherAccepted'; receipt: SessionReceipt; deposit?: string | undefined }
  | { type: 'settleStarted' }
  | { type: 'settled'; receipt: SessionReceipt; deposit?: string | undefined }
  | { type: 'closeRequested' }
  | { type: 'withdrawable' }
  | { type: 'closeStarted' }
  | { type: 'closed'; receipt?: SessionReceipt | undefined }

/** IO work requested by the pure reducer. */
export type SessionEffect =
  | { type: 'hydrate'; snapshot: SessionSnapshot }
  | { type: 'open' }
  | { type: 'topUp'; channelId: Hex; amount: string }
  | { type: 'voucher'; payload?: SessionCredentialPayload | undefined }
  | { type: 'settle'; channelId: Hex }
  | { type: 'requestClose'; channelId: Hex }
  | { type: 'withdraw'; channelId: Hex }
  | { type: 'close'; channelId: Hex }

/** Effects emitted by need-voucher transition planning. */
export type NeedVoucherSessionEffect =
  | Extract<SessionEffect, { type: 'topUp' }>
  | Extract<SessionEffect, { type: 'voucher' }>

/** Inputs for deciding whether a need-voucher event needs a voucher or deposit top-up first. */
export type ResolveNeedVoucherTransitionParameters = {
  /** Current challenge ID retained by the active session state. */
  challengeId: string
  /** Descriptor for the channel requiring more authorization. */
  descriptor: ChannelDescriptor
  /** Server event describing required cumulative authorization and current deposit. */
  event: NeedVoucherEvent
}

/** Result of the need-voucher transition decision. */
export type NeedVoucherTransition = {
  /** Next machine state. */
  state: NeedVoucherSessionState
  /** Driver effects required to satisfy the server request. */
  effects: NeedVoucherSessionEffect[]
}

/** Return value for every pure state-machine transition. */
export type SessionTransition = {
  /** State after applying the event. */
  state: SessionState
  /** Declarative IO requested from the transport/precompile driver. */
  effects: SessionEffect[]
}

/** Initial state for a TIP-1034 session state machine. */
export const initialState = { status: 'idle' } satisfies SessionState

/** Constructs the canonical active state shape for the reducer and transport drivers. */
export function createActiveState(parameters: CreateActiveStateParameters): ActiveSessionState {
  return { status: 'active', ...parameters }
}

/** Applies a state-machine event and returns the next state plus requested effects. */
export function reduce(state: SessionState, event: SessionEvent): SessionTransition {
  switch (event.type) {
    case 'challenge': {
      if (state.status !== 'idle' && state.status !== 'active') return invalid(state, event)
      if (event.snapshot) {
        return {
          state: { status: 'hydrating', challengeId: event.challengeId, snapshot: event.snapshot },
          effects: [{ type: 'hydrate', snapshot: event.snapshot }],
        }
      }
      return {
        state: { status: 'opening', challengeId: event.challengeId },
        effects: [{ type: 'open' }],
      }
    }
    case 'hydrated':
      if (state.status !== 'hydrating') return invalid(state, event)
      return {
        state: activeFromSnapshot(state.challengeId, event.snapshot),
        effects: [],
      }
    case 'opened':
      if (state.status !== 'opening') return invalid(state, event)
      return {
        state: activeFromReceipt(state.challengeId, event.receipt, event.descriptor, event.deposit),
        effects: [],
      }
    case 'needVoucher': {
      if (state.status !== 'active') return invalid(state, event)
      return resolveNeedVoucherTransition({
        challengeId: state.challengeId,
        descriptor: event.descriptor,
        event: event.event,
      })
    }
    case 'topUpStarted':
      if (state.status !== 'voucherNeeded') return invalid(state, event)
      return {
        state: {
          status: 'toppingUp',
          challengeId: state.challengeId,
          channelId: state.channelId,
          descriptor: state.descriptor,
          deposit: state.deposit,
        },
        effects: [],
      }
    case 'voucherAccepted':
      if (state.status !== 'voucherNeeded' && state.status !== 'toppingUp')
        return invalid(state, event)
      return {
        state: activeFromReceipt(
          state.challengeId,
          event.receipt,
          state.descriptor,
          event.deposit ?? state.deposit,
        ),
        effects: [],
      }
    case 'settleStarted':
      if (state.status !== 'active') return invalid(state, event)
      return {
        state: {
          status: 'settling',
          channelId: state.channelId,
          descriptor: state.descriptor,
          deposit: state.deposit,
        },
        effects: [{ type: 'settle', channelId: state.channelId }],
      }
    case 'settled':
      if (state.status !== 'settling') return invalid(state, event)
      return {
        state: activeFromReceipt(
          event.receipt.challengeId,
          event.receipt,
          state.descriptor,
          event.deposit ?? state.deposit,
        ),
        effects: [],
      }
    case 'closeRequested':
      if (state.status !== 'active') return invalid(state, event)
      return {
        state: {
          status: 'closeRequested',
          channelId: state.channelId,
          descriptor: state.descriptor,
        },
        effects: [{ type: 'requestClose', channelId: state.channelId }],
      }
    case 'withdrawable':
      if (state.status !== 'closeRequested') return invalid(state, event)
      return {
        state: { status: 'withdrawable', channelId: state.channelId, descriptor: state.descriptor },
        effects: [{ type: 'withdraw', channelId: state.channelId }],
      }
    case 'closeStarted':
      if (state.status !== 'active' && state.status !== 'withdrawable') return invalid(state, event)
      return {
        state: { status: 'closing', channelId: state.channelId, descriptor: state.descriptor },
        effects: [{ type: 'close', channelId: state.channelId }],
      }
    case 'closed':
      if (state.status !== 'closing' && state.status !== 'withdrawable')
        return invalid(state, event)
      return {
        state: { status: 'closed', channelId: state.channelId, descriptor: state.descriptor },
        effects: [],
      }
  }
}

/** Decides whether a need-voucher event can be answered by voucher or requires top-up first. */
export function resolveNeedVoucherTransition(
  parameters: ResolveNeedVoucherTransitionParameters,
): NeedVoucherTransition {
  const { challengeId, descriptor, event } = parameters
  const required = BigInt(event.requiredCumulative)
  const deposit = BigInt(event.deposit)

  if (required > deposit) {
    return {
      state: {
        status: 'toppingUp',
        challengeId,
        channelId: event.channelId,
        descriptor,
        deposit: event.deposit,
      },
      effects: [
        { type: 'topUp', channelId: event.channelId, amount: (required - deposit).toString() },
      ],
    }
  }

  return {
    state: {
      status: 'voucherNeeded',
      challengeId,
      channelId: event.channelId,
      descriptor,
      requiredCumulative: event.requiredCumulative,
      deposit: event.deposit,
    },
    effects: [{ type: 'voucher' }],
  }
}

function activeFromSnapshot(challengeId: string, snapshot: SessionSnapshot): SessionState {
  return createActiveState({
    challengeId,
    channelId: snapshot.channelId,
    descriptor: snapshot.descriptor,
    acceptedCumulative: snapshot.acceptedCumulative,
    deposit: snapshot.deposit,
    spent: snapshot.spent,
    units: snapshot.units ?? 0,
  })
}

function activeFromReceipt(
  challengeId: string,
  receipt: SessionReceipt,
  descriptor: ChannelDescriptor,
  deposit: RawAmountString,
): SessionState {
  return createActiveState({
    challengeId,
    channelId: receipt.channelId,
    descriptor,
    acceptedCumulative: receipt.acceptedCumulative,
    deposit,
    spent: receipt.spent,
    units: receipt.units ?? 0,
  })
}

function invalid(state: SessionState, event: SessionEvent): never {
  throw new Error(`Invalid session transition: ${state.status} + ${event.type}`)
}

/** Inputs for validating a cumulative authorization against the local client cap. */
export type LocalVoucherLimitParameters = {
  /** Cumulative amount being authorized or accepted. */
  cumulativeAmount: bigint
  /** Optional maximum local authorization boundary. Null means uncapped. */
  maxVoucherCumulative: bigint | null
}

/** Inputs for validating a payment receipt against local client state. */
export type LocalReceiptValidationParameters = {
  /** Active local channel cache entry. */
  channel: ChannelEntry | null
  /** Optional local authorization cap. Null means uncapped. */
  maxVoucherCumulative: bigint | null
  /** Receipt returned by the server. */
  receipt: SessionReceipt
}

/** Inputs for deriving the next locally observed spend from a receipt. */
export type NextReceiptSpendParameters = {
  /** Active local channel cache entry. */
  channel: ChannelEntry | null
  /** Optional local authorization cap. Null means uncapped. */
  maxVoucherCumulative: bigint | null
  /** Receipt returned by the server, when present. */
  receipt: SessionReceipt | null | undefined
  /** Current locally observed spend. */
  spent: bigint
}

/** Inputs for resolving the initial channel deposit in automatic client mode. */
export type ResolveOpeningDepositParameters = {
  /** Caller-provided raw deposit override. */
  contextDepositRaw?: string | undefined
  /** Optional local maximum cumulative deposit/authorization boundary. */
  maxDeposit?: bigint | undefined
  /** Current request amount in raw token units. */
  requestAmount: bigint
  /** Server-suggested opening deposit in raw token units. */
  suggestedDepositRaw?: string | undefined
}

/** Throws when a cumulative voucher amount exceeds the caller's local cap. */
export function assertVoucherWithinLocalLimit(parameters: LocalVoucherLimitParameters): void {
  const { cumulativeAmount, maxVoucherCumulative } = parameters
  if (maxVoucherCumulative === null) return
  if (cumulativeAmount <= maxVoucherCumulative) return
  throw new Error(
    `requested voucher amount ${cumulativeAmount} exceeds local maxDeposit ${maxVoucherCumulative}`,
  )
}

/** Validates a server receipt without allowing it to increase the local signing boundary. */
export function assertReceiptWithinLocalState(parameters: LocalReceiptValidationParameters): void {
  const { channel, maxVoucherCumulative, receipt } = parameters
  if (!channel || receipt.channelId !== channel.channelId) return
  const acceptedCumulative = BigInt(receipt.acceptedCumulative)
  const receiptSpent = BigInt(receipt.spent)
  if (receiptSpent > acceptedCumulative) {
    throw new Error('receipt spent exceeds accepted cumulative voucher amount')
  }
  if (acceptedCumulative > channel.cumulativeAmount) {
    throw new Error('receipt accepted cumulative exceeds local voucher state')
  }
  if (receiptSpent > channel.cumulativeAmount) {
    throw new Error('receipt spent exceeds local voucher state')
  }
  assertVoucherWithinLocalLimit({ cumulativeAmount: acceptedCumulative, maxVoucherCumulative })
  assertVoucherWithinLocalLimit({ cumulativeAmount: receiptSpent, maxVoucherCumulative })
}

/** Returns the monotonic next local spend after validating an optional receipt. */
export function nextSpentFromReceipt(parameters: NextReceiptSpendParameters): bigint {
  const { channel, maxVoucherCumulative, receipt, spent } = parameters
  if (!receipt || receipt.channelId !== channel?.channelId) return spent
  assertReceiptWithinLocalState({ channel, maxVoucherCumulative, receipt })
  const next = BigInt(receipt.spent)
  return spent > next ? spent : next
}

/** Parses a manager amount. Bigints are raw units; strings are parsed using token decimals. */
export function parseManagerAmount(amount: string | bigint, decimals: number): bigint {
  if (typeof amount === 'bigint') return amount
  return parseUnits(amount, decimals)
}

/** Resolves the opening deposit from explicit context, server hint, request amount, and local cap. */
export function resolveOpeningDeposit(parameters: ResolveOpeningDepositParameters): bigint {
  const { contextDepositRaw, maxDeposit, requestAmount, suggestedDepositRaw } = parameters
  assertWithinMaxDeposit(requestAmount, maxDeposit)
  if (contextDepositRaw !== undefined) {
    const deposit = BigInt(contextDepositRaw)
    if (deposit < requestAmount) {
      throw new Error(`opening deposit ${deposit} below request amount ${requestAmount}`)
    }
    return deposit
  }

  const suggestedDeposit =
    suggestedDepositRaw !== undefined ? BigInt(suggestedDepositRaw) : undefined
  const proposed =
    suggestedDeposit !== undefined && suggestedDeposit > requestAmount
      ? suggestedDeposit
      : requestAmount
  if (maxDeposit !== undefined) return proposed < maxDeposit ? proposed : maxDeposit
  return proposed
}

/** Enforces the optional client-side maximum cumulative voucher authorization. */
export function assertWithinMaxDeposit(
  cumulativeAmount: bigint,
  maxDeposit: bigint | undefined,
): void {
  assertVoucherWithinLocalLimit({
    cumulativeAmount,
    maxVoucherCumulative: maxDeposit ?? null,
  })
}

/** Predicate used when waiting for a specific session receipt. */
export type SessionReceiptPredicate = (receipt: SessionReceipt) => boolean

/** Resolved data required to close a locally active session channel. */
export type CloseTarget = {
  /** Challenge used to bind the close credential. */
  challenge: TempoSessionChallenge
  /** Local channel cache entry being closed. */
  channel: ChannelEntry
  /** Channel ID being closed. */
  channelId: Hex
}

/** Inputs for choosing the active close target. */
export type ResolveCloseTargetParameters = {
  /** Current active channel cache entry. */
  channel: ChannelEntry | null
  /** Active WebSocket session, when close is happening in-band. */
  currentSocket: ActiveSocketSession | null
  /** Last HTTP/SSE challenge observed by the manager. */
  lastChallenge: TempoSessionChallenge | null
}

/** Inputs for validating socket close-ready spend before signing the final close voucher. */
export type CloseReadySpendParameters = {
  /** Local cumulative voucher authorization. */
  cumulativeAmount: bigint
  /** Spend reported by the close-ready receipt. */
  readySpent: bigint
  /** Latest receipt-tracked local spend. */
  spent: bigint
}

/** Inputs for matching the expected final close receipt. */
export type ExpectedCloseReceiptParameters = {
  /** Challenge ID used for the close credential. */
  challengeId: string
  /** Channel ID being closed. */
  channelId: Hex
  /** Expected final cumulative/spent amount. */
  expectedCloseAmount: string
  /** Receipt to test. */
  receipt: SessionReceipt
}

/** Resolves the currently closeable channel and challenge, or undefined when no channel is open. */
export function resolveCloseTarget(
  parameters: ResolveCloseTargetParameters,
): CloseTarget | undefined {
  const { channel, currentSocket, lastChallenge } = parameters
  if (!channel?.opened) return undefined

  const challenge = currentSocket?.challenge ?? lastChallenge
  const channelId = currentSocket?.channelId ?? channel.channelId

  if (!challenge) {
    throw new Error(
      'Cannot close session: no challenge available. This usually means close() was called on a SessionManager instance that was recreated after the session was opened. Use the same SessionManager instance that opened the session, or make a request first to receive a fresh 402 challenge.',
    )
  }
  if (!channelId) {
    throw new Error(
      'Cannot close session: no channel ID available. The session may not have been fully opened.',
    )
  }

  return { challenge, channel, channelId }
}

/** Highest spend the client may sign for during close based on local receipts and vouchers. */
export function localCloseSpendLimit(parameters: Omit<CloseReadySpendParameters, 'readySpent'>) {
  const { cumulativeAmount, spent } = parameters
  return cumulativeAmount > spent ? cumulativeAmount : spent
}

/** Throws when a close-ready receipt asks the client to sign beyond local state. */
export function assertCloseReadyWithinLocalState(parameters: CloseReadySpendParameters): void {
  const { cumulativeAmount, readySpent, spent } = parameters
  if (readySpent > localCloseSpendLimit({ cumulativeAmount, spent })) {
    throw new Error('close-ready spent exceeds local voucher state')
  }
}

/** Returns whether a receipt is the expected final close settlement receipt. */
export function isExpectedCloseReceipt(parameters: ExpectedCloseReceiptParameters): boolean {
  const { challengeId, channelId, expectedCloseAmount, receipt } = parameters
  return (
    Boolean(receipt.txHash) &&
    receipt.challengeId === challengeId &&
    receipt.channelId === channelId &&
    receipt.acceptedCumulative === expectedCloseAmount &&
    receipt.spent === expectedCloseAmount
  )
}

/** Parameters used to project cached client channel data into an active machine state. */
export type ActiveStateFromChannelParameters = {
  /** Challenge ID associated with the active payment flow. */
  challengeId: string
  /** Cached channel entry that owns descriptor, deposit, and cumulative authorization. */
  entry: ChannelEntry
  /** Latest locally observed spend in raw units. */
  spent: string
  /** Paid units observed by the active flow. */
  units: number
}

/** Parameters used to project a closed channel into machine state. */
export type ClosedStateFromChannelParameters = {
  /** Channel ID that has been closed. */
  channelId: Hex
  /** Cached channel entry that owns the descriptor. */
  entry: ChannelEntry
}

/** Inputs for computing the safest fallback close amount when no fresh close-ready receipt is available. */
export type FallbackCloseAmountParameters = {
  /** Challenge ID being closed. */
  challengeId: string
  /** Channel ID being closed. */
  channelId: Hex
  /** Last socket close-ready receipt, when one was received. */
  closeReadyReceipt?: SessionReceipt | null | undefined
  /** Current local cumulative voucher authorization. */
  cumulativeAmount: bigint
  /** Number of application chunks delivered over the socket. */
  deliveredChunks?: bigint | undefined
  /** Current socket challenge ID, used to decide whether socket delivery data applies. */
  socketChallengeId?: string | undefined
  /** Current socket channel ID, used to decide whether socket delivery data applies. */
  socketChannelId?: Hex | undefined
  /** Latest locally observed spend from receipts. */
  spent: bigint
  /** Per-message socket charge in raw units. */
  tickCost?: bigint | undefined
}

/** Minimal mutable session runtime state that must be restored when an auto-drive attempt fails. */
export type RuntimeState = {
  /** Current client channel cache entry, when one is active. */
  channel: ChannelEntry | null
  /** Latest locally observed spend from receipts. */
  spent: bigint
  /** Current public state-machine state. */
  state: SessionState
}

/** Mutable client runtime state owned by one auto-driving `sessionManager()` instance. */
export type SessionManagerRuntime = RuntimeState & {
  /** Last Tempo session challenge observed by HTTP/SSE/WebSocket bootstrap. */
  lastChallenge: TempoSessionChallenge | null
  /** Last HTTP resource URL usable for management POSTs. */
  lastUrl: RequestInfo | URL | null
  /** Active WebSocket payment session bookkeeping, when a socket is open. */
  socketSession: ActiveSocketSession | null
}

/** Immutable snapshot of mutable runtime fields needed for rollback. */
export type RuntimeSnapshot = {
  /** Channel fields mutated during optimistic open/top-up/voucher attempts. */
  channel: {
    cumulativeAmount: bigint
    deposit: bigint
    entry: ChannelEntry
    opened: boolean
  } | null
  /** Latest locally observed spend when the snapshot was taken. */
  spent: bigint
  /** State-machine state when the snapshot was taken. */
  state: SessionState
}

/** Inputs for applying a server receipt to manager-local runtime state. */
export type ApplySessionReceiptToRuntimeParameters = {
  /** Optional local cumulative authorization cap. Null means uncapped. */
  maxVoucherCumulative: bigint | null
  /** Receipt returned by a server transport, when present. */
  receipt: SessionReceipt | null | undefined
  /** Mutable manager runtime state to update. */
  runtime: SessionManagerRuntime
}

/** Inputs for restoring local cumulative authorization after a failed optimistic voucher retry. */
export type RestoreCumulativeAuthorizationParameters = {
  /** Active local channel entry, when one is available. */
  channel: ChannelEntry | null
  /** Channel ID whose optimistic cumulative amount should be restored. */
  channelId: Hex
  /** Previous cumulative voucher authorization in raw units. */
  cumulativeAmount: bigint
  /** Last challenge ID observed by the manager, when known. */
  challengeId?: string | undefined
  /** Latest locally observed spend in raw units. */
  spent: bigint
  /** Current public state-machine state, used to preserve active unit count. */
  state: SessionState
}

/** Projects cached channel data into an active state-machine state. */
export function activeStateFromChannel(parameters: ActiveStateFromChannelParameters): SessionState {
  return createActiveState({
    challengeId: parameters.challengeId,
    channelId: parameters.entry.channelId,
    descriptor: parameters.entry.descriptor,
    acceptedCumulative: parameters.entry.cumulativeAmount.toString(),
    deposit: parameters.entry.deposit.toString(),
    spent: parameters.spent,
    units: parameters.units,
  })
}

/** Creates the initial mutable runtime state for an auto-driving session manager. */
export function createSessionManagerRuntime(): SessionManagerRuntime {
  return {
    channel: null,
    lastChallenge: null,
    lastUrl: null,
    spent: 0n,
    socketSession: null,
    state: initialState,
  }
}

/** Validates a receipt, advances observed spend, and projects matching receipts into public state. */
export function applySessionReceiptToRuntime(
  parameters: ApplySessionReceiptToRuntimeParameters,
): void {
  const { maxVoucherCumulative, receipt, runtime } = parameters
  runtime.spent = nextSpentFromReceipt({
    channel: runtime.channel,
    maxVoucherCumulative,
    receipt,
    spent: runtime.spent,
  })
  if (receipt && runtime.channel?.channelId === receipt.channelId) {
    runtime.state = activeStateFromReceipt(receipt, runtime.channel)
  }
}

/** Projects a verified receipt plus local descriptor/deposit data into an active state-machine state. */
export function activeStateFromReceipt(receipt: SessionReceipt, entry: ChannelEntry): SessionState {
  return createActiveState({
    challengeId: receipt.challengeId,
    channelId: receipt.channelId,
    descriptor: entry.descriptor,
    acceptedCumulative: receipt.acceptedCumulative,
    deposit: entry.deposit.toString(),
    spent: receipt.spent,
    units: receipt.units ?? 0,
  })
}

/** Projects a closed channel into the public closed state-machine state. */
export function closedStateFromChannel(parameters: ClosedStateFromChannelParameters): SessionState {
  return {
    status: 'closed',
    channelId: parameters.channelId,
    descriptor: parameters.entry.descriptor,
  }
}

/** Projects a final close receipt into the public closed state-machine state. */
export function closedStateFromReceipt(receipt: SessionReceipt, entry: ChannelEntry): SessionState {
  return closedStateFromChannel({ channelId: receipt.channelId, entry })
}

/**
 * Computes the fallback close amount without authorizing more than the local cumulative voucher.
 *
 * Priority:
 * 1. Matching close-ready receipt spend.
 * 2. Matching socket delivery estimate (`deliveredChunks * tickCost`) clamped by cumulative.
 * 3. Latest receipt-tracked spend for HTTP/SSE.
 */
export function computeFallbackCloseAmount(parameters: FallbackCloseAmountParameters): bigint {
  const {
    challengeId,
    channelId,
    closeReadyReceipt,
    cumulativeAmount,
    deliveredChunks = 0n,
    socketChallengeId,
    socketChannelId,
    spent,
    tickCost = 0n,
  } = parameters

  if (
    closeReadyReceipt &&
    closeReadyReceipt.challengeId === challengeId &&
    closeReadyReceipt.channelId === channelId
  ) {
    return BigInt(closeReadyReceipt.spent)
  }

  if (socketChallengeId === challengeId && socketChannelId === channelId && tickCost > 0n) {
    const deliveryEstimate = deliveredChunks * tickCost
    const bestSpent = spent > deliveryEstimate ? spent : deliveryEstimate
    return bestSpent > cumulativeAmount ? cumulativeAmount : bestSpent
  }

  return spent
}

/**
 * Restores a channel's cumulative voucher boundary and returns the refreshed active state.
 *
 * Returns `undefined` when the active channel does not match or no challenge is
 * available to label the active state.
 */
export function restoreCumulativeAuthorization(
  parameters: RestoreCumulativeAuthorizationParameters,
): SessionState | undefined {
  const { channel, channelId, challengeId, cumulativeAmount, spent, state } = parameters
  if (!channel || channel.channelId !== channelId) return undefined
  channel.cumulativeAmount = cumulativeAmount
  if (!challengeId) return undefined
  return activeStateFromChannel({
    challengeId,
    entry: channel,
    spent: spent.toString(),
    units: state.status === 'active' ? state.units : 0,
  })
}

/** Captures mutable session runtime fields before an optimistic manager action. */
export function captureRuntimeSnapshot(runtime: RuntimeState): RuntimeSnapshot {
  return {
    channel:
      runtime.channel === null
        ? null
        : {
            entry: runtime.channel,
            cumulativeAmount: runtime.channel.cumulativeAmount,
            deposit: runtime.channel.deposit,
            opened: runtime.channel.opened,
          },
    spent: runtime.spent,
    state: runtime.state,
  }
}

/** Restores mutable session runtime fields from a previous snapshot. */
export function restoreRuntimeSnapshot(
  snapshot: RuntimeSnapshot,
  currentChannel: ChannelEntry | null,
): RuntimeState {
  if (snapshot.channel) {
    snapshot.channel.entry.cumulativeAmount = snapshot.channel.cumulativeAmount
    snapshot.channel.entry.deposit = snapshot.channel.deposit
    snapshot.channel.entry.opened = snapshot.channel.opened
    return {
      channel: snapshot.channel.entry,
      spent: snapshot.spent,
      state: snapshot.state,
    }
  }

  if (currentChannel) currentChannel.opened = false
  return {
    channel: null,
    spent: snapshot.spent,
    state: snapshot.state,
  }
}

/** Creates a session credential for the selected challenge/context. */
export type CreateSocketCloseCredential = (
  challenge: TempoSessionChallenge,
  context: SessionContext,
) => Promise<string>

/** Inputs for cooperatively closing an active WebSocket session in-band. */
export type CloseSocketSessionParameters = {
  /** Raw WebSocket used by the active paid stream. */
  activeSocket: WebSocket
  /** Creates the signed close credential. */
  createSessionCredential: CreateSocketCloseCredential
  /** Active WebSocket session state. */
  currentSocket: ActiveSocketSession
  /** Latest locally tracked spend from receipts. */
  spent: bigint
  /** Channel/challenge pair being closed. */
  target: CloseTarget
  /** Waits for the server's close-ready receipt after requesting stream close. */
  waitForCloseReady(): Promise<SessionReceipt>
  /** Waits for the final settlement receipt matching `predicate`. */
  waitForReceipt(predicate: SessionReceiptPredicate): Promise<SessionReceipt>
}

/** Cooperatively closes an active paid WebSocket session and returns the final receipt. */
export async function closeSocketSession(
  parameters: CloseSocketSessionParameters,
): Promise<SessionReceipt> {
  const { activeSocket, currentSocket, target } = parameters
  const ready =
    currentSocket.closeReadyReceipt ??
    (await (async () => {
      activeSocket.send(Ws.formatCloseRequestMessage())
      return parameters.waitForCloseReady()
    })())
  const readySpent = BigInt(ready.spent)
  assertCloseReadyWithinLocalState({
    cumulativeAmount: target.channel.cumulativeAmount,
    readySpent,
    spent: parameters.spent,
  })

  const credential = await parameters.createSessionCredential(target.challenge, {
    action: 'close',
    channelId: target.channelId,
    descriptor: target.channel.descriptor,
    cumulativeAmountRaw: readySpent.toString(),
  })

  const expectedCloseAmount = readySpent.toString()
  currentSocket.expectedCloseAmount = expectedCloseAmount
  try {
    const pendingReceipt = parameters.waitForReceipt((receipt) =>
      isExpectedCloseReceipt({
        challengeId: target.challenge.id,
        channelId: target.channelId,
        expectedCloseAmount,
        receipt,
      }),
    )
    activeSocket.send(Ws.formatAuthorizationMessage(credential))
    const receipt = await pendingReceipt
    activeSocket.close()
    currentSocket.closeReadyReceipt = null
    return receipt
  } finally {
    currentSocket.expectedCloseAmount = null
  }
}
