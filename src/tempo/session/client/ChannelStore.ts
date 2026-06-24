import type { Address } from 'viem'

import type { MaybePromise } from '../../../internal/types.js'
import type { ChannelEntry } from './ChannelOps.js'

/** Store of reusable payer session channels keyed by payment scope. */
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
