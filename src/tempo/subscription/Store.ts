import * as Store from '../../Store.js'
import type { SubscriptionRecord } from './Types.js'

const defaultRecordPrefix = 'tempo:subscription:record:'
const defaultResourcePrefix = 'tempo:subscription:resource:'

/** Subscription-aware wrapper around a generic key-value store. */
export type SubscriptionStore = {
  get: (subscriptionId: string) => Promise<SubscriptionRecord | null>
  getByIdentityResource: (identityId: string, resourceId: string) => Promise<SubscriptionRecord | null>
  put: (record: SubscriptionRecord) => Promise<void>
}

/** Wraps a generic key-value {@link Store.Store} with subscription-specific accessors. */
export function fromStore(
  store: Store.Store<Record<string, unknown>>,
  options?: fromStore.Options,
): SubscriptionStore {
  const recordPrefix = options?.recordPrefix ?? defaultRecordPrefix
  const resourcePrefix = options?.resourcePrefix ?? defaultResourcePrefix

  function recordKey(subscriptionId: string): string {
    return `${recordPrefix}${subscriptionId}`
  }

  function resourceKey(identityId: string, resourceId: string): string {
    return `${resourcePrefix}${identityId}:${resourceId}`
  }

  return {
    async get(subscriptionId) {
      return (await store.get(recordKey(subscriptionId))) as SubscriptionRecord | null
    },

    /** Looks up the single subscription for an identity+resource pair. */
    async getByIdentityResource(identityId, resourceId) {
      const id = (await store.get(resourceKey(identityId, resourceId))) as string | null
      if (!id) return null
      return (await store.get(recordKey(id))) as SubscriptionRecord | null
    },

    /**
     * Upserts a subscription record and sets it as the active subscription
     * for the identity+resource pair, replacing any previous subscription.
     */
    async put(record) {
      await store.put(recordKey(record.subscriptionId), record)
      await store.put(
        resourceKey(record.identityId, record.resourceId),
        record.subscriptionId,
      )
    },
  }
}

export declare namespace fromStore {
  type Options = {
    /** Key prefix for subscription records. @default `'tempo:subscription:record:'` */
    recordPrefix?: string | undefined
    /** Key prefix for identity→resource indexes. @default `'tempo:subscription:resource:'` */
    resourcePrefix?: string | undefined
  }
}
