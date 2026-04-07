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

  /**
   * Finds the best reusable channel for a payer and session dimensions.
   *
   * Implementations may return `null` when no reusable channel exists or when
   * reverse lookup is not supported by the backing store.
   */
  findReusableChannel?(options: ReusableChannelQuery): Promise<State | null>
}

export type ReusableChannelQuery = {
  amount?: bigint | undefined
  chainId?: number | undefined
  escrowContract: Address
  payee: Address
  payer: Address
  token: Address
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
    if (current.finalized) return current
    if (current.highestVoucherAmount - current.spent >= amount) {
      deducted = true
      return { ...current, spent: current.spent + amount, units: current.units + 1 }
    }
    return current
  })
  if (!channel) throw new Error('channel not found')
  return { ok: deducted, channel }
}

export async function findReusableChannel(
  store: ChannelStore,
  options: ReusableChannelQuery,
): Promise<State | null> {
  if (!store.findReusableChannel) return null
  return store.findReusableChannel(options)
}

function payerIndexKey(payer: Address): `mppx:session:payer:${string}` {
  return `mppx:session:payer:${payer.toLowerCase()}`
}

function normalizeChannelIds(channelIds: readonly Hex[]): Hex[] {
  return [...new Set(channelIds.map((channelId) => channelId.toLowerCase() as Hex))]
}

function sameChannelIds(left: readonly Hex[], right: readonly Hex[]): boolean {
  if (left.length !== right.length) return false
  for (let index = 0; index < left.length; index++) {
    if (left[index]!.toLowerCase() !== right[index]!.toLowerCase()) return false
  }
  return true
}

function compareHexDesc(left: Hex, right: Hex): number {
  return right.localeCompare(left)
}

function compareBigIntDesc(left: bigint, right: bigint): number {
  if (left === right) return 0
  return left > right ? -1 : 1
}

function compareNumberDesc(left: number, right: number): number {
  if (left === right) return 0
  return left > right ? -1 : 1
}

function createdAtScore(channel: State): number {
  const timestamp = Date.parse(channel.createdAt)
  return Number.isNaN(timestamp) ? 0 : timestamp
}

function isReusableChannel(channel: State, options: ReusableChannelQuery): boolean {
  if (channel.finalized || channel.deposit === 0n || channel.closeRequestedAt !== 0n) return false
  if (channel.payer.toLowerCase() !== options.payer.toLowerCase()) return false
  if (channel.payee.toLowerCase() !== options.payee.toLowerCase()) return false
  if (channel.token.toLowerCase() !== options.token.toLowerCase()) return false
  if (channel.escrowContract.toLowerCase() !== options.escrowContract.toLowerCase()) return false
  if (options.chainId !== undefined && channel.chainId !== options.chainId) return false

  if (options.amount !== undefined) {
    const requiredCumulative =
      channel.spent + options.amount > channel.highestVoucherAmount
        ? channel.spent + options.amount
        : channel.highestVoucherAmount
    if (requiredCumulative > channel.deposit) return false
  }

  return true
}

function compareReusableChannels(left: State, right: State): number {
  return (
    compareNumberDesc(createdAtScore(left), createdAtScore(right)) ||
    compareBigIntDesc(left.highestVoucherAmount, right.highestVoucherAmount) ||
    compareBigIntDesc(left.spent, right.spent) ||
    compareHexDesc(left.channelId, right.channelId)
  )
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

  async function withLock<value>(key: string, fn: () => Promise<value>): Promise<value> {
    while (locks.has(key)) await locks.get(key)

    let release!: () => void
    locks.set(
      key,
      new Promise<void>((r) => {
        release = r
      }),
    )

    try {
      return await fn()
    } finally {
      locks.delete(key)
      release()
    }
  }

  function notify(channelId: string) {
    const set = waiters.get(channelId)
    if (!set) return
    for (const resolve of set) resolve()
    waiters.delete(channelId)
  }

  async function updatePayerIndex(
    payer: Address,
    update: (current: readonly Hex[]) => readonly Hex[],
  ): Promise<void> {
    const key = payerIndexKey(payer)
    await withLock(key, async () => {
      const current = ((await store.get(key as never)) as Hex[] | null) ?? []
      const next = normalizeChannelIds(update(current))
      if (sameChannelIds(current, next)) return
      if (next.length === 0) {
        await store.delete(key as never)
        return
      }
      await store.put(key as never, next as never)
    })
  }

  async function syncPayerIndex(
    channelId: Hex,
    current: State | null,
    next: State | null,
  ): Promise<void> {
    const normalizedChannelId = channelId.toLowerCase() as Hex
    const currentPayer = current?.payer.toLowerCase() as Address | undefined
    const nextPayer = next?.payer.toLowerCase() as Address | undefined

    if (currentPayer && currentPayer !== nextPayer) {
      await updatePayerIndex(currentPayer, (entries) =>
        entries.filter((entry) => entry.toLowerCase() !== normalizedChannelId),
      )
    }

    if (!nextPayer) return

    await updatePayerIndex(nextPayer, (entries) =>
      entries.some((entry) => entry.toLowerCase() === normalizedChannelId)
        ? entries
        : [...entries, normalizedChannelId],
    )
  }

  async function update(
    channelId: Hex,
    fn: (current: State | null) => State | null,
  ): Promise<State | null> {
    return withLock(channelId, async () => {
      const current = (await store.get(channelId)) as State | null
      const next = fn(current)
      if (next) await store.put(channelId, next as never)
      else await store.delete(channelId)
      await syncPayerIndex(channelId, current, next)
      return next
    })
  }

  const cs: ChannelStore = {
    async getChannel(channelId) {
      return (await store.get(channelId)) as State | null
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
    async findReusableChannel(options) {
      const key = payerIndexKey(options.payer)
      const channelIds = ((await store.get(key as never)) as Hex[] | null) ?? []
      if (channelIds.length === 0) return null

      const channels = await Promise.all(channelIds.map((channelId) => cs.getChannel(channelId)))
      const missing = channelIds.filter((_channelId, index) => !channels[index])
      if (missing.length > 0) {
        const missingSet = new Set(missing.map((channelId) => channelId.toLowerCase()))
        await updatePayerIndex(options.payer, (entries) =>
          entries.filter((entry) => !missingSet.has(entry.toLowerCase())),
        )
      }

      const reusable = channels
        .filter((channel): channel is State => channel !== null)
        .filter((channel) => isReusableChannel(channel, options))
        .sort(compareReusableChannels)

      return reusable[0] ?? null
    },
  }

  storeCache.set(store, cs)
  return cs
}
