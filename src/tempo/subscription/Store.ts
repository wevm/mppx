import * as Store from '../../Store.js'
import type { SubscriptionRecord } from './Types.js'

const defaultRecordPrefix = 'tempo:subscription:record:'
const defaultKeyPrefix = 'tempo:subscription:key:'

/** Subscription-aware wrapper around a generic key-value store. */
export type SubscriptionStore = {
  get: (subscriptionId: string) => Promise<SubscriptionRecord | null>
  getByKey: (key: string) => Promise<SubscriptionRecord | null>
  put: (record: SubscriptionRecord) => Promise<void>
}

/** Wraps a generic key-value {@link Store.Store} with subscription-specific accessors. */
export function fromStore(
  store: Store.Store<Record<string, unknown>>,
  options?: fromStore.Options,
): SubscriptionStore {
  const recordPrefix = options?.recordPrefix ?? defaultRecordPrefix
  const keyPrefix = options?.keyPrefix ?? defaultKeyPrefix

  function recordKey(subscriptionId: string): string {
    return `${recordPrefix}${subscriptionId}`
  }

  function lookupKey(key: string): string {
    return `${keyPrefix}${key}`
  }

  return {
    async get(subscriptionId) {
      return (await store.get(recordKey(subscriptionId))) as SubscriptionRecord | null
    },

    /** Looks up the active subscription for a resolved request key. */
    async getByKey(key) {
      const id = (await store.get(lookupKey(key))) as string | null
      if (!id) return null
      return (await store.get(recordKey(id))) as SubscriptionRecord | null
    },

    /** Upserts a subscription record and marks it as active for its lookup key. */
    async put(record) {
      await store.put(recordKey(record.subscriptionId), record)
      await store.put(lookupKey(record.lookupKey), record.subscriptionId)
    },
  }
}

export declare namespace fromStore {
  type Options = {
    /** Key prefix for subscription records. @default `'tempo:subscription:record:'` */
    recordPrefix?: string | undefined
    /** Key prefix for resolved request keys. @default `'tempo:subscription:key:'` */
    keyPrefix?: string | undefined
  }
}
