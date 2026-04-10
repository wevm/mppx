import * as Store from '../../Store.js'
import type { SubscriptionRecord } from './Types.js'

const recordPrefix = 'tempo:subscription:record:'
const resourcePrefix = 'tempo:subscription:resource:'

export type SubscriptionStore = {
  get: (subscriptionId: string) => Promise<SubscriptionRecord | null>
  listByIdentityResource: (identityId: string, resourceId: string) => Promise<SubscriptionRecord[]>
  put: (record: SubscriptionRecord) => Promise<void>
}

export function fromStore(store: Store.Store<Record<string, unknown>>): SubscriptionStore {
  return {
    async get(subscriptionId) {
      return (await store.get(recordKey(subscriptionId))) as SubscriptionRecord | null
    },
    async listByIdentityResource(identityId, resourceId) {
      const ids = ((await store.get(resourceKey(identityId, resourceId))) ?? []) as string[]
      const records = await Promise.all(
        ids.map(async (subscriptionId: string) => store.get(recordKey(subscriptionId))),
      )
      return records.filter((record: unknown): record is SubscriptionRecord => Boolean(record))
    },
    async put(record) {
      await store.put(recordKey(record.subscriptionId), record)

      const key = resourceKey(record.identityId, record.resourceId)
      const existing = ((await store.get(key)) ?? []) as string[]
      if (!existing.includes(record.subscriptionId)) {
        await store.put(key, [...existing, record.subscriptionId])
      }
    },
  }
}

function recordKey(subscriptionId: string): string {
  return `${recordPrefix}${subscriptionId}`
}

function resourceKey(identityId: string, resourceId: string): string {
  return `${resourcePrefix}${identityId}:${resourceId}`
}
