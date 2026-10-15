import type { Address } from 'viem'

import type { MaybePromise } from '../../../internal/types.js'
import type { ChannelEntry } from './ChannelOps.js'

/**
 * Store of reusable payer session channels keyed by payment scope.
 * Callers sharing a backend across processes must coordinate funding and writes externally.
 */
export type ChannelStore = {
  /** Returns the channel cached for `key`, when present. */
  get(key: string): MaybePromise<ChannelEntry | undefined>
  /** Inserts or replaces a channel entry. */
  set(entry: ChannelEntry): MaybePromise<void>
  /** Removes the channel cached for `key`. */
  delete(key: string): MaybePromise<void>
}

/** Channel persistence and update notification for credential results. */
export type ChannelSink = {
  store: ChannelStore
  notifyUpdate: (entry: ChannelEntry) => void
}

/** Returns the scope key for a reusable payer session channel. */
export function channelKey(scope: {
  payee: Address
  token: Address
  escrow: Address
  chainId: number
}): string {
  const { payee, token, escrow, chainId } = scope
  return `${payee.toLowerCase()}:${token.toLowerCase()}:${escrow.toLowerCase()}:${chainId}`
}

/** Returns the scope key for a stored channel entry. */
export function entryKey(entry: ChannelEntry): string {
  return channelKey({
    payee: entry.descriptor.payee,
    token: entry.descriptor.token,
    escrow: entry.escrow,
    chainId: entry.chainId,
  })
}

/** Creates the default in-memory {@link ChannelStore}. */
export function createChannelStore(): ChannelStore {
  const channels = new Map<string, ChannelEntry>()
  return {
    get: (key) => channels.get(key),
    set(entry) {
      channels.set(entryKey(entry), entry)
    },
    delete(key) {
      channels.delete(key)
    },
  } satisfies ChannelStore
}

/** JSON-safe projection of a {@link ChannelEntry}, with bigint amounts as decimal strings. */
export type StoredChannel = Omit<ChannelEntry, 'cumulativeAmount' | 'deposit'> & {
  /** Cumulative voucher authorization in raw token units, as a decimal string. */
  cumulativeAmount: string
  /** Channel deposit in raw token units, as a decimal string. */
  deposit: string
}

/** Converts a channel entry into its JSON-safe stored form. */
export function serializeEntry(entry: ChannelEntry): StoredChannel {
  return {
    ...entry,
    cumulativeAmount: entry.cumulativeAmount.toString(),
    deposit: entry.deposit.toString(),
  }
}

/** Restores a channel entry from its JSON-safe stored form. */
export function deserializeEntry(stored: StoredChannel): ChannelEntry {
  return {
    ...stored,
    cumulativeAmount: BigInt(stored.cumulativeAmount),
    deposit: BigInt(stored.deposit),
  }
}

/** Prefix for serialized channel entries persisted by {@link createJsonChannelStore}. */
const channelPrefix = 'chan:'

/** Plain string key-value backend a {@link createJsonChannelStore} persists into. */
export type JsonChannelKv = {
  /** Returns the value stored at `key`, when present. */
  get(key: string): MaybePromise<string | undefined>
  /** Persists a `value` at `key`. */
  set(key: string, value: string): MaybePromise<void>
  /** Removes the value stored at `key`. */
  delete(key: string): MaybePromise<void>
}

/** Wraps a string KV backend as a bigint-safe channel store. */
export function createJsonChannelStore(kv: JsonChannelKv): ChannelStore {
  return {
    async get(key) {
      const value = await kv.get(channelPrefix + key)
      if (value === undefined) return undefined
      return deserializeEntry(JSON.parse(value) as StoredChannel)
    },
    async set(entry) {
      await kv.set(channelPrefix + entryKey(entry), JSON.stringify(serializeEntry(entry)))
    },
    async delete(key) {
      await kv.delete(channelPrefix + key)
    },
  } satisfies ChannelStore
}

const pendingOperations = new WeakMap<ChannelStore, Map<string, Promise<unknown>>>()
const fundingStores = new WeakMap<ChannelStore, ChannelStore>()

/** @internal Shares funding coordination between a manager's store view and its backing store. */
export function registerFundingStore(view: ChannelStore, backing: ChannelStore): void {
  fundingStores.set(view, fundingStores.get(backing) ?? backing)
}

async function exclusive<T>(
  store: ChannelStore,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  let pending = pendingOperations.get(store)
  if (!pending) {
    pending = new Map()
    pendingOperations.set(store, pending)
  }
  const previous = pending.get(key) ?? Promise.resolve()
  const result = previous.catch(() => {}).then(operation)
  pending.set(key, result)
  try {
    return await result
  } finally {
    if (pending.get(key) === result) pending.delete(key)
  }
}

/** @internal Serializes funding decisions for callers sharing one backing store in this process. */
export function withFundingLock<T>(
  store: ChannelStore,
  key: string,
  operation: () => Promise<T>,
): Promise<T> {
  return exclusive(fundingStores.get(store) ?? store, `funding:${key}`, operation)
}

/** @internal Serializes writes and preserves unresolved funding across stale channel copies. */
export async function persistChannel(store: ChannelStore, entry: ChannelEntry): Promise<void> {
  await exclusive(store, `write:${entryKey(entry)}`, async () => {
    const current = await store.get(entryKey(entry))
    if (current?.uncertainTopUp) {
      if (current.channelId !== entry.channelId)
        throw new Error(
          'Session funding outcome is unknown; reconcile the pending payment before replacing the channel.',
        )
      entry.uncertainTopUp = true
    }
    await store.set(entry)
  })
}

/** @internal Retains unresolved funding records through close and stale-entry cleanup. */
export async function deleteChannel(store: ChannelStore, key: string): Promise<void> {
  await exclusive(store, `write:${key}`, async () => {
    if ((await store.get(key))?.uncertainTopUp) return
    await store.delete(key)
  })
}
