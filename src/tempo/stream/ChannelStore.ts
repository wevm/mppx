import type { Address, Hex } from 'viem'
import type * as Store from '../../Store.js'
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
export interface State {
  /** Address authorized to sign vouchers on behalf of the payer. */
  authorizedSigner: Address
  /** Unique identifier for this payment channel. */
  channelId: Hex
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
}

export type DeductResult = { ok: true; channel: State } | { ok: false; channel: State }

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
  let deducted = false
  const channel = await store.updateChannel(channelId, (current) => {
    deducted = false
    if (!current) return null
    if (current.highestVoucherAmount - current.spent >= amount) {
      deducted = true
      return { ...current, spent: current.spent + amount, units: current.units + 1 }
    }
    return current
  })
  if (!channel) throw new Error('channel not found')
  return { ok: deducted, channel }
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

export function fromStore(store: Store.Store): ChannelStore {
  const cached = storeCache.get(store)
  if (cached) return cached

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
    while (locks.has(channelId)) await locks.get(channelId)

    let release!: () => void
    locks.set(
      channelId,
      new Promise<void>((r) => {
        release = r
      }),
    )

    try {
      const current = await store.get<State | null>(channelId)
      const next = fn(current)
      if (next) await store.put(channelId, next)
      else await store.delete(channelId)
      return next
    } finally {
      locks.delete(channelId)
      release()
    }
  }

  const cs: ChannelStore = {
    async getChannel(channelId) {
      return store.get<State | null>(channelId)
    },
    async updateChannel(channelId, fn) {
      const result = await update(channelId, fn)
      notify(channelId)
      return result
    },
    waitForUpdate(channelId) {
      return new Promise<void>((resolve) => {
        let set = waiters.get(channelId)
        if (!set) {
          set = new Set()
          waiters.set(channelId, set)
        }
        set.add(resolve)
      })
    },
  }

  storeCache.set(store, cs)
  return cs
}
