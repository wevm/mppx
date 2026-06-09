import type { Address, Hex } from 'viem'

import type * as Challenge from '../../../Challenge.js'
import {
  AmountExceedsDepositError,
  ChannelClosedError,
  ChannelNotFoundError,
  DeltaTooSmallError,
  InvalidSignatureError,
  VerificationFailedError,
} from '../../../Errors.js'
import type * as Store from '../../../Store.js'
import type * as Chain from '../precompile/Chain.js'
import type * as PrecompileChannel from '../precompile/Channel.js'
import { createSessionReceipt } from '../precompile/Protocol.js'
import type { SessionReceipt, SessionSignedVoucher } from '../precompile/Protocol.js'
import { uint96, type SignedVoucher } from '../precompile/Protocol.js'
import * as Voucher from '../precompile/Voucher.js'
import {
  assertSameDescriptor,
  validateChannelDescriptor,
  validateChannelState,
} from './CredentialVerification.js'
import type { SessionMethodDetails } from './RequestState.js'

/**
 * State for an on-chain payment channel, including per-session accounting.
 *
 * Tracks the channel's identity, on-chain balance, the highest voucher
 * the server has accepted, and the current session's spend counters.
 * A channel is created when a payer opens an escrow on-chain and persists
 * until the channel is finalized (closed/settled).
 *
 * One channel = one session. The client owns the key and can't race with
 * itself, so concurrent session support is unnecessary.
 *
 * Monotonicity invariants (enforced by update callbacks):
 * - `highestVoucherAmount` only increases
 * - `settledOnChain` only increases
 * - `deposit` reflects the latest on-chain value
 */
export type State = BaseState & BackendState

/** Result of an atomic channel deduction attempt. */
export type DeductResult = { ok: true; channel: State } | { ok: false; channel: State }

/** Persisted channel state after narrowing to the TIP-1034 precompile backend. */
export type StoredPrecompileChannel = BaseState & PrecompileBackendState

/** On-chain state fields read from the TIP-1034 precompile. */
export type OnChainChannelState = {
  /** Current on-chain channel deposit. */
  deposit: bigint
  /** Cumulative amount settled on-chain. */
  settled: bigint
  /** Close-request timestamp, or zero when open. */
  closeRequestedAt: number | bigint
}

/** Persisted fields that mirror authoritative on-chain channel state. */
export type ActiveOnChainStateFields = Pick<
  State,
  'closeRequestedAt' | 'deposit' | 'settledOnChain'
>

/** Parameters for selecting the persisted highest accepted voucher. */
export type HighestVoucherParameters = {
  /** Channel ID used when constructing a new voucher record. */
  channelId: Hex
  /** Existing persisted voucher amount and signature, when present. */
  current?: Pick<State, 'highestVoucher' | 'highestVoucherAmount'> | null | undefined
  /** Candidate cumulative voucher amount. */
  cumulativeAmount: bigint
  /** Candidate voucher signature. */
  signature: Hex
}

/** Highest accepted voucher amount plus signed voucher payload. */
export type HighestVoucher = {
  /** Highest cumulative voucher amount to persist. */
  highestVoucherAmount: bigint
  /** Signed voucher corresponding to `highestVoucherAmount`. */
  highestVoucher: SessionSignedVoucher | null
}

/** Inputs for resolving the amount a close transaction should capture. */
export type ResolveCloseCaptureAmountParameters = {
  /** Close voucher cumulative amount. */
  cumulativeAmount: bigint
  /** Current on-chain deposit. */
  onChainDeposit: bigint
  /** Current on-chain settled amount. */
  onChainSettled: bigint
  /** Locally recorded paid spend. */
  spent: bigint
}

/** Inputs used when persisting or reconciling a successful open transaction. */
export type OpenChannelStateParameters = {
  /** Address stored as the effective voucher signer for this channel. */
  authorizedSigner: Address
  /** Chain ID used by the opened channel. */
  chainId: number
  /** Normalized channel ID. */
  channelId: Hex
  /** Existing channel state, when one was already persisted. */
  current: State | null
  /** Descriptor verified from the open transaction. */
  descriptor: PrecompileChannel.ChannelDescriptor
  /** Escrow precompile address used by the channel. */
  escrow: Address
  /** Transaction-bound expiring nonce hash from the open call. */
  expiringNonceHash: Hex
  /** Initial or highest accepted cumulative voucher amount. */
  cumulativeAmount: bigint
  /** Voucher signature for `cumulativeAmount`. */
  signature: Hex
  /** Latest on-chain channel state read after open. */
  state: Chain.ChannelState
}

/** Inputs for merging a successful top-up transaction into persisted channel state. */
export type TopUpStateParameters = {
  /** Existing channel state, when one is currently persisted. */
  current: State | null
  /** Latest verified on-chain channel state read after top-up. */
  state: Chain.ChannelState
}

/** Inputs for merging a newly accepted voucher with persisted channel state. */
export type AcceptVoucherStateUpdateParameters = {
  /** Latest on-chain channel state used to validate the voucher. */
  channelState: Chain.ChannelState
  /** Existing channel state being updated. */
  current: State | null
  /** Verified signed voucher. */
  voucher: SessionSignedVoucher
}

/** Inputs for marking a channel as pending cooperative close. */
export type MarkPendingCloseParameters = {
  /** Timestamp used to mark the local pending-close state. */
  closeRequestedAt: bigint
  /** Close voucher cumulative amount. */
  cumulativeAmount: bigint
  /** Existing channel state being updated. */
  current: State | null
  /** Current on-chain deposit. */
  onChainDeposit: bigint
  /** Current on-chain settled amount. */
  onChainSettled: bigint
}

/** Result of preparing local state for a cooperative close. */
export type PendingCloseUpdate = {
  /** Amount that should be captured on-chain at close. */
  captureAmount: bigint
  /** Next local channel state, or null if no channel exists. */
  state: State | null
}

/** Inputs for finalizing local state after a successful close transaction. */
export type FinalizeClosedChannelParameters = {
  /** Amount captured to payee during close. */
  captureAmount: bigint
  /** Normalized channel ID. */
  channelId: Hex
  /** Close voucher cumulative amount. */
  cumulativeAmount: bigint
  /** Existing channel state being updated. */
  current: State | null
  /** Close voucher signature. */
  signature: Hex
}

/** Immutable channel identity fields derived from a verified TIP-1034 descriptor. */
export type PrecompileChannelIdentity = Pick<
  BaseState & PrecompileBackendState,
  | 'authorizedSigner'
  | 'backend'
  | 'chainId'
  | 'channelId'
  | 'descriptor'
  | 'escrowContract'
  | 'expiringNonceHash'
  | 'operator'
  | 'payee'
  | 'payer'
  | 'salt'
  | 'token'
>

/** Inputs used to derive immutable persisted channel identity fields. */
export type ResolvePrecompileChannelIdentityParameters = {
  /** Address stored as the effective voucher signer for this channel. */
  authorizedSigner: Address
  /** Chain ID used by the opened channel. */
  chainId: number
  /** Normalized channel ID. */
  channelId: Hex
  /** Descriptor verified from the open transaction. */
  descriptor: PrecompileChannel.ChannelDescriptor
  /** Escrow precompile address used by the channel. */
  escrow: Address
  /** Transaction-bound expiring nonce hash from the open call. */
  expiringNonceHash: Hex
}

/** Inputs for reading a persisted precompile channel and validating its descriptor. */
export type LoadPrecompileChannelParameters = {
  /** Channel ID to read from the server store. */
  channelId: Hex
  /** Chain ID used to rederive the channel descriptor. */
  chainId: number
  /** Descriptor supplied by the credential payload. */
  descriptor: StoredPrecompileChannel['descriptor']
  /** Escrow precompile address used to derive the channel ID. */
  escrow: Address
  /** Server channel store. */
  store: ChannelStore
  /** Whether to also validate descriptor identity against chain/payee/token fields. */
  validateDescriptor?: boolean | undefined
}

/** Inputs for validating a signed voucher and merging it into channel state. */
export type VerifyAndAcceptVoucherParameters = {
  /** Credential challenge used to bind the returned receipt. */
  challenge: Challenge.Challenge
  /** Persisted channel state before voucher acceptance. */
  channel: State
  /** Latest on-chain state used as the deposit/settled authority. */
  channelState: Chain.ChannelState
  /** Session method details used for voucher signature domain separation. */
  methodDetails: SessionMethodDetails
  /** Minimum allowed voucher delta in raw units. */
  minVoucherDelta: bigint
  /** Server channel store. */
  store: ChannelStore
  /** Signed cumulative voucher to verify and accept. */
  voucher: SignedVoucher
}

/** Channel backend-specific fields. */
export type BackendState = CompatibilityBackendState | PrecompileBackendState

/** State for records owned by a backend outside the TIP-1034 precompile path. */
export interface CompatibilityBackendState {
  /** Optional backend marker for older stored records. */
  backend?: 'contract' | 'external' | undefined
}

/** State for a TIP20EscrowChannel precompile-backed payment channel. */
export interface PrecompileBackendState {
  /** Channel backend. */
  backend: 'precompile'
  /** Descriptor used to derive the channel's identity. */
  descriptor: PrecompileChannel.ChannelDescriptor
  /** Transaction-bound nonce hash used to derive the channel's identity. */
  expiringNonceHash: Hex
  /** Address authorized to operate the channel. */
  operator: Address
  /** Salt used to derive the channel's identity. */
  salt: Hex
}

/** Common persisted state for every session channel backend. */
export interface BaseState {
  /** Address authorized to sign vouchers on behalf of the payer. */
  authorizedSigner: Address
  /** Chain ID the channel was opened on. */
  chainId: number
  /** Escrow contract address the channel was opened on. */
  escrowContract: Address
  /** Unique identifier for this payment channel. */
  channelId: Hex
  /** On-chain timestamp when a force-close was requested (0n if not requested). */
  closeRequestedAt: bigint
  /** ISO 8601 timestamp when the channel was created. */
  createdAt: string
  /** Current on-chain deposit in the escrow contract. */
  deposit: bigint
  /** Whether the channel has been finalized (closed) on-chain. */
  finalized: boolean
  /** The signed voucher corresponding to `highestVoucherAmount`. */
  highestVoucher: SessionSignedVoucher | null
  /** Highest cumulative voucher amount accepted by the server. */
  highestVoucherAmount: bigint
  /** Address of the payment recipient. */
  payee: Address
  /** Address of the payment sender. */
  payer: Address
  /** Cumulative amount settled on-chain so far. */
  settledOnChain: bigint
  /** Cumulative amount spent (charged) against this channel's current session. */
  spent: bigint
  /** Token contract address used for payments. */
  token: Address
  /** Number of charge operations (API requests) fulfilled in the current session. */
  units: number
  /** ISO 8601 timestamp of the last server-scheduled settlement. */
  lastSettlementAt?: string | undefined
  /** Cumulative spent value when the last server-scheduled settlement ran. */
  lastSettlementSpent?: bigint | undefined
  /** Charge operation count when the last server-scheduled settlement ran. */
  lastSettlementUnits?: number | undefined
}

/** Returns whether a channel is backed by the TIP20EscrowChannel precompile. */
export function isPrecompileState(state: State): state is BaseState & PrecompileBackendState {
  return state.backend === 'precompile'
}

/** Returns the greater bigint value without decreasing persisted monotonic state. */
export function keepGreater(current: bigint, next: bigint): bigint {
  return current > next ? current : next
}

/** Returns the greater close-request timestamp as a bigint. */
export function keepGreaterTimestamp(current: bigint, next: number | bigint): bigint {
  return keepGreater(current, BigInt(next))
}

/** Keeps local active-channel state in sync with authoritative on-chain reads. */
export function mergeActiveOnChainState(
  current: Partial<ActiveOnChainStateFields> | null | undefined,
  state: OnChainChannelState,
): ActiveOnChainStateFields {
  return {
    closeRequestedAt: keepGreaterTimestamp(current?.closeRequestedAt ?? 0n, state.closeRequestedAt),
    deposit: keepGreater(current?.deposit ?? 0n, state.deposit),
    settledOnChain: keepGreater(current?.settledOnChain ?? 0n, state.settled),
  }
}

/** Keeps the existing higher voucher, otherwise stores the supplied candidate voucher. */
export function resolveHighestVoucher(parameters: HighestVoucherParameters): HighestVoucher {
  const { channelId, current, cumulativeAmount, signature } = parameters
  if (current?.highestVoucherAmount && current.highestVoucherAmount > cumulativeAmount) {
    return {
      highestVoucherAmount: current.highestVoucherAmount,
      highestVoucher: current.highestVoucher,
    }
  }

  return {
    highestVoucherAmount: cumulativeAmount,
    highestVoucher: { channelId, cumulativeAmount, signature },
  }
}

/** Derives persisted identity fields from a verified precompile channel descriptor. */
export function resolvePrecompileChannelIdentity(
  parameters: ResolvePrecompileChannelIdentityParameters,
): PrecompileChannelIdentity {
  const { authorizedSigner, chainId, channelId, descriptor, escrow, expiringNonceHash } = parameters
  return {
    authorizedSigner,
    backend: 'precompile',
    chainId,
    channelId,
    descriptor,
    escrowContract: escrow,
    expiringNonceHash,
    operator: descriptor.operator,
    payee: descriptor.payee,
    payer: descriptor.payer,
    salt: descriptor.salt,
    token: descriptor.token,
  }
}

/** Builds the persisted state for a verified precompile channel open. */
export function openChannelState(parameters: OpenChannelStateParameters): State {
  const { authorizedSigner, chainId, channelId, current, descriptor, escrow, expiringNonceHash } =
    parameters
  const { state } = parameters
  const { cumulativeAmount, signature } = parameters
  const highestVoucher = resolveHighestVoucher({
    channelId,
    current,
    cumulativeAmount,
    signature,
  })
  const onChain = mergeActiveOnChainState(current, state)
  return {
    ...(current ?? {}),
    ...resolvePrecompileChannelIdentity({
      authorizedSigner,
      chainId,
      channelId,
      descriptor,
      escrow,
      expiringNonceHash,
    }),
    closeRequestedAt: onChain.closeRequestedAt,
    deposit: onChain.deposit,
    settledOnChain: onChain.settledOnChain,
    highestVoucherAmount: highestVoucher.highestVoucherAmount,
    highestVoucher: highestVoucher.highestVoucher,
    spent: keepGreater(current?.spent ?? 0n, state.settled),
    units: current?.units ?? 0,
    finalized: current?.finalized ?? false,
    createdAt: current?.createdAt ?? new Date().toISOString(),
  }
}

/** Merges top-up on-chain state into persisted channel state without decreasing monotonic fields. */
export function topUpChannelState(parameters: TopUpStateParameters): State | null {
  const { current, state } = parameters
  if (!current) return current
  return {
    ...current,
    ...mergeActiveOnChainState(current, state),
  }
}

/** Merges an accepted voucher into persisted channel state after signature and on-chain checks pass. */
export function acceptVoucherStateUpdate(parameters: AcceptVoucherStateUpdateParameters): State {
  const { channelState, current, voucher } = parameters
  if (!current) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (current.finalized) throw new ChannelClosedError({ reason: 'channel is finalized' })
  if (current.closeRequestedAt !== 0n)
    throw new ChannelClosedError({ reason: 'channel has a pending close request' })

  const onChain = mergeActiveOnChainState(current, channelState)

  if (voucher.cumulativeAmount <= current.highestVoucherAmount) {
    return { ...current, ...onChain }
  }

  return {
    ...current,
    ...onChain,
    highestVoucherAmount: voucher.cumulativeAmount,
    highestVoucher: voucher,
  }
}

/**
 * Resolves the close capture amount and validates it is covered by both the
 * close voucher and current on-chain deposit.
 */
export function resolveCloseCaptureAmount(parameters: ResolveCloseCaptureAmountParameters): bigint {
  const { cumulativeAmount, onChainDeposit, onChainSettled, spent } = parameters
  if (cumulativeAmount < spent) {
    throw new VerificationFailedError({
      reason: `close voucher amount must be >= ${spent} (spent)`,
    })
  }

  const captureAmount = uint96(spent > onChainSettled ? spent : onChainSettled)
  if (captureAmount > cumulativeAmount) {
    throw new VerificationFailedError({
      reason: `close voucher amount must be >= ${captureAmount} (capture amount)`,
    })
  }
  if (captureAmount > onChainDeposit) {
    throw new AmountExceedsDepositError({
      reason: 'close capture amount exceeds on-chain deposit',
    })
  }
  return captureAmount
}

/** Marks local channel state as pending close and returns the bounded capture amount. */
export function markPendingClose(parameters: MarkPendingCloseParameters): PendingCloseUpdate {
  const { closeRequestedAt, cumulativeAmount, current, onChainSettled, onChainDeposit } = parameters
  if (!current) return { captureAmount: 0n, state: null }
  if (current.finalized) throw new ChannelClosedError({ reason: 'channel is already finalized' })
  if (current.closeRequestedAt !== 0n)
    throw new ChannelClosedError({ reason: 'channel has a pending close request' })
  const captureAmount = resolveCloseCaptureAmount({
    cumulativeAmount,
    onChainDeposit,
    onChainSettled,
    spent: current.spent,
  })

  return {
    captureAmount,
    state: { ...current, closeRequestedAt },
  }
}

/** Finalizes local channel state after a successful close transaction. */
export function finalizeClosedChannelState(
  parameters: FinalizeClosedChannelParameters,
): State | null {
  const { captureAmount, channelId, cumulativeAmount, current, signature } = parameters
  if (!current) return current
  const highestVoucher = resolveHighestVoucher({
    channelId,
    current,
    cumulativeAmount,
    signature,
  })
  return {
    ...current,
    finalized: true,
    closeRequestedAt: 0n,
    deposit: 0n,
    settledOnChain: keepGreater(current.settledOnChain, captureAmount),
    highestVoucherAmount: highestVoucher.highestVoucherAmount,
    highestVoucher: highestVoucher.highestVoucher,
  }
}

/** Loads a precompile-backed channel or throws a verification error. */
export async function loadPrecompileChannel(
  parameters: LoadPrecompileChannelParameters,
): Promise<StoredPrecompileChannel> {
  const { channelId, chainId, descriptor, escrow, store } = parameters
  const channel = await store.getChannel(channelId)
  if (!channel) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (!isPrecompileState(channel))
    throw new VerificationFailedError({ reason: 'channel is not precompile-backed' })
  assertSameDescriptor(descriptor, channel.descriptor)
  if (parameters.validateDescriptor)
    validateChannelDescriptor(descriptor, channelId, chainId, escrow, channel.payee, channel.token)
  return channel
}

/** Verifies a cumulative voucher and returns a session receipt after store reconciliation. */
export async function verifyAndAcceptVoucher(
  parameters: VerifyAndAcceptVoucherParameters,
): Promise<SessionReceipt> {
  const { store, minVoucherDelta, challenge, channel, voucher, channelState, methodDetails } =
    parameters

  validateChannelState(channelState)
  if (voucher.cumulativeAmount > channelState.deposit)
    throw new AmountExceedsDepositError({ reason: 'voucher amount exceeds on-chain deposit' })
  if (voucher.cumulativeAmount < channel.highestVoucherAmount)
    throw new VerificationFailedError({
      reason: 'voucher cumulativeAmount must be strictly greater than highest accepted voucher',
    })
  const valid = await Voucher.verifyVoucher(
    methodDetails.escrowContract,
    methodDetails.chainId,
    voucher,
    channel.authorizedSigner,
  )
  if (!valid) throw new InvalidSignatureError({ reason: 'invalid voucher signature' })

  if (voucher.cumulativeAmount === channel.highestVoucherAmount)
    return createSessionReceipt({
      challengeId: challenge.id,
      channelId: voucher.channelId,
      acceptedCumulative: channel.highestVoucherAmount,
      spent: channel.spent,
      units: channel.units,
    })
  if (voucher.cumulativeAmount <= channelState.settled)
    throw new VerificationFailedError({
      reason: 'voucher cumulativeAmount is below on-chain settled amount',
    })
  const delta = voucher.cumulativeAmount - channel.highestVoucherAmount
  if (delta < minVoucherDelta)
    throw new DeltaTooSmallError({
      reason: `voucher delta ${delta} below minimum ${minVoucherDelta}`,
    })
  const updated = await store.updateChannel(voucher.channelId, (current) =>
    acceptVoucherStateUpdate({ channelState, current, voucher }),
  )
  if (!updated) throw new ChannelNotFoundError({ reason: 'channel not found' })
  return createSessionReceipt({
    challengeId: challenge.id,
    channelId: voucher.channelId,
    acceptedCumulative: updated.highestVoucherAmount,
    spent: updated.spent,
    units: updated.units,
  })
}

/**
 * Internal store interface for channel state persistence.
 *
 * ## Atomicity contract
 *
 * The `updateChannel` method uses an atomic read-modify-write callback.
 * The callback receives the current state (or `null` if none exists), and
 * returns the next state (or `null` to delete). Implementations must
 * guarantee that no concurrent mutation occurs between reading `current`
 * and writing the return value.
 *
 * Callbacks should be synchronous and deterministic. When a `ChannelStore`
 * is backed by `Store.update()`, adapters may retry them internally.
 *
 * Backends implement this via their native mechanisms:
 * - **In-memory / JS single-thread**: Synchronous callback execution
 * - **Durable Objects**: Single-threaded execution model
 * - **D1 / SQL**: Database transactions
 */
export type ChannelStore = {
  getChannel(channelId: Hex): Promise<State | null>

  /**
   * Atomic read-modify-write for channel state.
   * Return `null` from `fn` to delete the channel.
   */
  updateChannel(channelId: Hex, fn: (current: State | null) => State | null): Promise<State | null>

  /**
   * Wait for the next update to a channel.
   *
   * Returns a `Promise` that resolves once `updateChannel` is called for
   * `channelId`. Implementations should resolve immediately if the channel
   * was updated between the call to `waitForUpdate` and the `Promise`
   * being awaited.
   *
   * When not implemented, callers fall back to polling.
   */
  waitForUpdate?(channelId: Hex): Promise<void>

  /**
   * Atomic read-modify-write that returns the callback's `result` directly.
   *
   * Used by {@link deductFromChannel} to atomically compute the deduction
   * outcome. When backed by `Store.update()`, this delegates to the store's
   * native atomic primitive.
   */
  updateChannelResult?<result>(
    channelId: Hex,
    fn: (current: State | null) => Store.Change<State, result>,
  ): Promise<result>
}

/** Normalizes and validates 32-byte channel IDs before store lookup or persistence. */
export function normalizeChannelId(channelId: string): Hex {
  if (!/^0x[0-9a-fA-F]{64}$/.test(channelId)) throw new Error('Invalid session channel ID.')
  return channelId.toLowerCase() as Hex
}

type StateStore = Store.Store<Record<string, State>> &
  Partial<Store.AtomicActions<Record<string, State>>>

/** Atomic store change carrying normalized channel state. */
type ChannelStateChange<result> = Store.Change<State, result>

/** Store change carrying the result of an attempted spend deduction. */
type DeductionChange = Store.Change<State, DeductResult | null>

/** Mutable runtime state for one generic-store adapter instance. */
type StoreAdapterRuntime = {
  /** Per-channel in-process locks used when the backend has no atomic update primitive. */
  locks: Map<string, Promise<void>>
  /** Waiters notified after the next mutation for a normalized channel ID. */
  waiters: Map<string, Set<() => void>>
}

function normalizeState(channelId: Hex, state: State): State {
  return state.channelId === channelId ? state : { ...state, channelId }
}

function normalizeMaybeState(channelId: Hex, state: State | null): State | null {
  return state ? normalizeState(channelId, state) : null
}

/** Normalizes any stored channel value inside a store change. */
function normalizeChange<result>(
  channelId: Hex,
  change: ChannelStateChange<result>,
): ChannelStateChange<result> {
  if (change.op !== 'set') return change
  return {
    ...change,
    value: normalizeState(channelId, change.value),
  }
}

/**
 * Wraps a generic {@link Store} into the internal {@link Store}
 * interface used by server handlers and the SSE metering loop.
 *
 * Provides `waitForUpdate` notifications so the SSE `chargeOrWait` loop
 * can wake up without polling.
 *
 * ## Atomicity
 *
 * Mutations use `get` → `fn` → `set` guarded by a per-key in-process
 * mutex. This serializes concurrent `updateChannel` calls within a
 * single JS runtime but does **not** protect against races across
 * multiple processes or instances.
 *
 * Backends that need true atomicity (e.g., Durable Objects, D1)
 * should implement {@link Store} directly.
 */
const storeCache = new WeakMap<Store.Store, ChannelStore>()

/** Wraps a generic mppx store in the shared session channel-store interface. */
export function fromStore(store: Store.Store | Store.AtomicStore): ChannelStore {
  const cached = storeCache.get(store)
  if (cached) return cached

  const stateStore = store as StateStore
  const atomicUpdate = stateStore.update

  const runtime: StoreAdapterRuntime = {
    locks: new Map(),
    waiters: new Map(),
  }

  function notify(channelId: string) {
    const set = runtime.waiters.get(channelId)
    if (!set) return
    for (const resolve of set) resolve()
    runtime.waiters.delete(channelId)
  }

  async function update(
    channelId: Hex,
    fn: (current: State | null) => State | null,
  ): Promise<State | null> {
    return updateResult(channelId, (current) => {
      const next = fn(current)
      if (next) return { op: 'set', value: next, result: next }
      return { op: 'delete', result: null }
    })
  }

  async function updateResult<result>(
    channelId: Hex,
    fn: (current: State | null) => Store.Change<State, result>,
  ): Promise<result> {
    const normalizedChannelId = normalizeChannelId(channelId)
    let change: Store.Change<State, result> | undefined

    if (atomicUpdate) {
      const result = await atomicUpdate(normalizedChannelId, (current) => {
        const normalizedCurrent = normalizeMaybeState(normalizedChannelId, current)
        change = normalizeChange(normalizedChannelId, fn(normalizedCurrent))
        return change
      })
      if (change?.op !== 'noop') notify(normalizedChannelId)
      return result
    }

    while (runtime.locks.has(normalizedChannelId)) await runtime.locks.get(normalizedChannelId)

    let release!: () => void
    runtime.locks.set(
      normalizedChannelId,
      new Promise<void>((r) => {
        release = r
      }),
    )

    try {
      const current = normalizeMaybeState(
        normalizedChannelId,
        await stateStore.get(normalizedChannelId),
      )
      change = normalizeChange(normalizedChannelId, fn(current))
      if (change.op === 'set') {
        await stateStore.put(normalizedChannelId, change.value)
      }
      if (change.op === 'delete') await stateStore.delete(normalizedChannelId)
      if (change.op !== 'noop') notify(normalizedChannelId)
      return change.result
    } finally {
      runtime.locks.delete(normalizedChannelId)
      release()
    }
  }

  const cs: ChannelStore = {
    async getChannel(channelId) {
      const normalizedChannelId = normalizeChannelId(channelId)
      return normalizeMaybeState(normalizedChannelId, await stateStore.get(normalizedChannelId))
    },
    async updateChannel(channelId, fn) {
      return update(channelId, fn)
    },
    waitForUpdate(channelId) {
      return new Promise<void>((resolve) => {
        const normalizedChannelId = normalizeChannelId(channelId)
        let set = runtime.waiters.get(normalizedChannelId)
        if (!set) {
          set = new Set()
          runtime.waiters.set(normalizedChannelId, set)
        }
        set.add(resolve)
      })
    },
  }

  cs.updateChannelResult = updateResult

  storeCache.set(store, cs)
  return cs
}

/**
 * Atomically deducts `amount` from a channel's available voucher balance.
 *
 * Returns `{ ok: true, channel }` with updated spend/unit counters when the
 * deduction succeeds. Returns `{ ok: false, channel }` without mutating state
 * when the channel exists but cannot currently be charged.
 */
export async function deductFromChannel(
  store: ChannelStore,
  channelId: State['channelId'],
  amount: bigint,
): Promise<DeductResult> {
  if (store.updateChannelResult) {
    const result = await store.updateChannelResult<DeductResult | null>(
      channelId,
      (current): DeductionChange => planDeduction(current, amount),
    )
    if (!result) throw new Error('channel not found')
    return result
  }

  let result: DeductResult | null = null
  const channel = await store.updateChannel(channelId, (current) => {
    const change = planDeduction(current, amount)
    result = change.result
    if (change.op === 'set') return change.value
    return current
  })
  if (!channel) throw new Error('channel not found')
  return result ?? { ok: false, channel }
}

function planDeduction(current: State | null, amount: bigint): DeductionChange {
  if (!current) return { op: 'noop', result: null }
  if (current.finalized) return { op: 'noop', result: { ok: false, channel: current } }
  if (current.closeRequestedAt !== 0n)
    return { op: 'noop', result: { ok: false, channel: current } }
  if (current.highestVoucherAmount - current.spent < amount)
    return { op: 'noop', result: { ok: false, channel: current } }

  const next = { ...current, spent: current.spent + amount, units: current.units + 1 }
  return { op: 'set', value: next, result: { ok: true, channel: next } }
}
