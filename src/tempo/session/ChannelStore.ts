import type { Address, Hex } from 'viem'

import type * as Store from '../../Store.js'
import type * as PrecompileChannel from '../precompile/Channel.js'
import type { SignedVoucher } from './Types.js'

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

export type BackendState = ContractBackendState | PrecompileBackendState

/** State for a smart-contract-backed payment channel. */
export interface ContractBackendState {
  /** Channel backend. Omitted for existing contract-backed records. */
  backend?: 'contract' | undefined
}

/** State for a TIP-1034 precompile-backed payment channel. */
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
  highestVoucher: SignedVoucher | null
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
}

/** Returns whether a channel is backed by the TIP-1034 precompile. */
export function isPrecompileState(state: State): state is BaseState & PrecompileBackendState {
  return state.backend === 'precompile'
}

/** Returns whether a channel is backed by the smart contract escrow. */
export function isContractState(state: State): state is BaseState & ContractBackendState {
  return state.backend === undefined || state.backend === 'contract'
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

export type DeductResult = { ok: true; channel: State } | { ok: false; channel: State }

export function normalizeChannelId(channelId: Hex): Hex {
  return channelId.toLowerCase() as Hex
}

function normalizeState(channelId: Hex, state: State): State {
  return state.channelId === channelId ? state : { ...state, channelId }
}

function normalizeMaybeState(channelId: Hex, state: State | null): State | null {
  return state ? normalizeState(channelId, state) : null
}

/**
 * Atomically deduct `amount` from a channel's available balance.
 *
 * Returns `{ ok: true, channel }` if the deduction succeeded, or
 * `{ ok: false, channel }` with the unchanged state if balance is
 * insufficient. Throws if the channel does not exist.
 */
export async function deductFromChannel(
  store: ChannelStore,
  channelId: Hex,
  amount: bigint,
): Promise<DeductResult> {
  if (store.updateChannelResult) {
    const result = await store.updateChannelResult<DeductResult | null>(
      channelId,
      (current): Store.Change<State, DeductResult | null> => {
        if (!current) return { op: 'noop', result: null }
        if (current.finalized)
          return { op: 'noop', result: { ok: false, channel: current } as const }
        if (current.closeRequestedAt !== 0n)
          return { op: 'noop', result: { ok: false, channel: current } as const }
        if (current.highestVoucherAmount - current.spent >= amount) {
          const next = { ...current, spent: current.spent + amount, units: current.units + 1 }
          return { op: 'set', value: next, result: { ok: true, channel: next } as const }
        }
        return { op: 'noop', result: { ok: false, channel: current } as const }
      },
    )
    if (!result) throw new Error('channel not found')
    return result
  }

  let result: DeductResult | null = null
  const channel = await store.updateChannel(channelId, (current) => {
    if (!current) return null
    if (current.finalized) {
      result = { ok: false, channel: current }
      return current
    }
    if (current.closeRequestedAt !== 0n) {
      result = { ok: false, channel: current }
      return current
    }
    if (current.highestVoucherAmount - current.spent >= amount) {
      const next = { ...current, spent: current.spent + amount, units: current.units + 1 }
      result = { ok: true, channel: next }
      return next
    }
    result = { ok: false, channel: current }
    return current
  })
  if (!channel) throw new Error('channel not found')
  return result ?? { ok: false, channel }
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

export function fromStore(store: Store.Store | Store.AtomicStore): ChannelStore {
  const cached = storeCache.get(store)
  if (cached) return cached

  const atomicUpdate = 'update' in store ? (store as Store.AtomicStore).update : undefined

  const waiters = new Map<string, Set<() => void>>()
  const locks = new Map<string, Promise<void>>()

  function notify(channelId: string) {
    const set = waiters.get(channelId)
    if (!set) return
    for (const resolve of set) resolve()
    waiters.delete(channelId)
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
        change = fn(normalizeMaybeState(normalizedChannelId, (current as State | null) ?? null))
        if (change.op === 'set') {
          change = {
            ...change,
            value: normalizeState(normalizedChannelId, change.value),
          }
        }
        if (change.op !== 'set') return change
        return { ...change, value: change.value as never }
      })
      if (change?.op !== 'noop') notify(normalizedChannelId)
      return result
    }

    while (locks.has(normalizedChannelId)) await locks.get(normalizedChannelId)

    let release!: () => void
    locks.set(
      normalizedChannelId,
      new Promise<void>((r) => {
        release = r
      }),
    )

    try {
      const current = normalizeMaybeState(
        normalizedChannelId,
        (await store.get(normalizedChannelId)) as State | null,
      )
      change = fn(current)
      if (change.op === 'set') {
        change = {
          ...change,
          value: normalizeState(normalizedChannelId, change.value),
        }
        await store.put(normalizedChannelId, change.value as never)
      }
      if (change.op === 'delete') await store.delete(normalizedChannelId)
      if (change.op !== 'noop') notify(normalizedChannelId)
      return change.result
    } finally {
      locks.delete(normalizedChannelId)
      release()
    }
  }

  const cs: ChannelStore = {
    async getChannel(channelId) {
      const normalizedChannelId = normalizeChannelId(channelId)
      return normalizeMaybeState(
        normalizedChannelId,
        (await store.get(normalizedChannelId)) as State | null,
      )
    },
    async updateChannel(channelId, fn) {
      return update(channelId, fn)
    },
    waitForUpdate(channelId) {
      return new Promise<void>((resolve) => {
        const normalizedChannelId = normalizeChannelId(channelId)
        let set = waiters.get(normalizedChannelId)
        if (!set) {
          set = new Set()
          waiters.set(normalizedChannelId, set)
        }
        set.add(resolve)
      })
    },
  }

  cs.updateChannelResult = updateResult

  storeCache.set(store, cs)
  return cs
}
