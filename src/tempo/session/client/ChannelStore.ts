import type { Address } from 'viem'

import type { MaybePromise } from '../../../internal/types.js'
import type { ChannelEntry } from './ChannelOps.js'

/**
 * Pluggable store of reusable payer session channels, keyed by payment scope
 * ({@link channelKey}). The plugin resumes from it after a 402 challenge reveals
 * the payee/token (`store.get(resolved.key)`), and writes the latest cumulative
 * voucher state back after each request.
 *
 * The plugin defaults to an in-memory implementation ({@link createChannelStore});
 * a wallet can back it with durable storage via {@link createJsonChannelStore}.
 * All methods may be async.
 */
export type ChannelStore = {
  /** Returns the channel cached for a payment-scope `key` (see {@link channelKey}), when present. */
  get(key: string): MaybePromise<ChannelEntry | undefined>
  /** Inserts or replaces a channel entry. The payment-scope key is derived from the entry. */
  set(entry: ChannelEntry): MaybePromise<void>
  /** Removes the channel cached for a payment-scope `key`. */
  delete(key: string): MaybePromise<void>
}

/** A channel store paired with its update observer, used to persist credential results. */
export type ChannelSink = {
  /** Persistence for reusable channels. */
  store: ChannelStore
  /** Called after each write with the latest entry, bridging to the public `onChannelUpdate`. */
  notifyUpdate: (entry: ChannelEntry) => void
}

/** Returns the scope key for a reusable payer session channel. */
export function channelKey(
  payee: Address,
  token: Address,
  escrow: Address,
  chainId: number,
): string {
  return `${payee.toLowerCase()}:${token.toLowerCase()}:${escrow.toLowerCase()}:${chainId}`
}

/** Returns the scope key for a stored channel entry. */
export function entryKey(entry: ChannelEntry): string {
  return channelKey(entry.descriptor.payee, entry.descriptor.token, entry.escrow, entry.chainId)
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

/**
 * Wraps a plain string {@link JsonChannelKv} backend as a {@link ChannelStore},
 * handling key derivation, namespacing, and bigint-safe (de)serialization so a
 * durable backend only implements plain string get/set/delete. Channel entries
 * are stored under a `chan:` prefix.
 */
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
