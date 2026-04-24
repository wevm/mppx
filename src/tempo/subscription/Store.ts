import * as Store from '../../Store.js'
import type { SubscriptionRecord } from './Types.js'

const defaultRecordPrefix = 'tempo:subscription:record:'
const defaultResourcePrefix = 'tempo:subscription:resource:'
const defaultPendingTimeoutMs = 5 * 60 * 1_000

/** Subscription-aware wrapper around a generic key-value store. */
export type SubscriptionStore = {
  activate: (record: SubscriptionRecord) => Promise<void>
  claimPendingCapture: (
    subscriptionId: string,
    periodIndex: number,
    now: number,
  ) => Promise<SubscriptionRecord | null>
  clearPendingCapture: (subscriptionId: string, periodIndex: number) => Promise<void>
  completePendingCapture: (record: SubscriptionRecord, periodIndex: number) => Promise<void>
  get: (subscriptionId: string) => Promise<SubscriptionRecord | null>
  getActive: (identityId: string, resourceId: string) => Promise<SubscriptionRecord | null>
  markCanceled: (
    subscriptionId: string,
    cancelEffectiveAt: string,
  ) => Promise<SubscriptionRecord | null>
  markRevoked: (subscriptionId: string, revokedAt: string) => Promise<SubscriptionRecord | null>
  save: (record: SubscriptionRecord) => Promise<void>
}

/** Wraps a generic atomic {@link Store.Store} with subscription-specific accessors. */
export function fromStore(
  store: Store.AtomicStore<Record<string, unknown>>,
  options?: fromStore.Options,
): SubscriptionStore {
  const recordPrefix = options?.recordPrefix ?? defaultRecordPrefix
  const pendingTimeoutMs = options?.pendingTimeoutMs ?? defaultPendingTimeoutMs
  const resourcePrefix = options?.resourcePrefix ?? defaultResourcePrefix

  function recordKey(subscriptionId: string): string {
    return `${recordPrefix}${subscriptionId}`
  }

  function resourceKey(identityId: string, resourceId: string): string {
    return `${resourcePrefix}${identityId}:${resourceId}`
  }

  return {
    async activate(record) {
      const key = resourceKey(record.identityId, record.resourceId)
      const previousId = (await store.get(key)) as string | null
      if (previousId && previousId !== record.subscriptionId) {
        await store.update(recordKey(previousId), (current) => {
          const currentRecord = current as SubscriptionRecord | null
          if (!currentRecord) return { op: 'noop', result: undefined }
          return {
            op: 'set',
            result: undefined,
            value: {
              ...currentRecord,
              cancelEffectiveAt: currentRecord.cancelEffectiveAt ?? record.timestamp,
              pendingPeriod: undefined,
              pendingPeriodStartedAt: undefined,
            } satisfies SubscriptionRecord,
          }
        })
      }

      await store.put(recordKey(record.subscriptionId), {
        ...record,
        pendingPeriod: undefined,
        pendingPeriodStartedAt: undefined,
      })
      await store.put(key, record.subscriptionId)
    },

    async claimPendingCapture(subscriptionId, periodIndex, now) {
      return store.update(recordKey(subscriptionId), (current) => {
        const currentRecord = current as SubscriptionRecord | null
        if (!currentRecord) return { op: 'noop', result: null }
        if (currentRecord.lastChargedPeriod >= periodIndex) return { op: 'noop', result: null }

        const pendingStartedAt = currentRecord.pendingPeriodStartedAt
          ? new Date(currentRecord.pendingPeriodStartedAt).getTime()
          : Number.NaN
        const pendingExpired =
          !Number.isFinite(pendingStartedAt) || now - pendingStartedAt > pendingTimeoutMs
        if (
          currentRecord.pendingPeriod !== undefined &&
          currentRecord.pendingPeriod >= periodIndex &&
          !pendingExpired
        ) {
          return { op: 'noop', result: null }
        }

        const next = {
          ...currentRecord,
          pendingPeriod: periodIndex,
          pendingPeriodStartedAt: new Date(now).toISOString(),
        } satisfies SubscriptionRecord
        return { op: 'set', result: next, value: next }
      })
    },

    async clearPendingCapture(subscriptionId, periodIndex) {
      await store.update(recordKey(subscriptionId), (current) => {
        const currentRecord = current as SubscriptionRecord | null
        if (!currentRecord || currentRecord.pendingPeriod !== periodIndex) {
          return { op: 'noop', result: undefined }
        }

        return {
          op: 'set',
          result: undefined,
          value: {
            ...currentRecord,
            pendingPeriod: undefined,
            pendingPeriodStartedAt: undefined,
          } satisfies SubscriptionRecord,
        }
      })
    },

    async completePendingCapture(record, periodIndex) {
      await store.update(recordKey(record.subscriptionId), (current) => {
        const currentRecord = current as SubscriptionRecord | null
        const merged = {
          ...(currentRecord ?? record),
          ...record,
          pendingPeriod: undefined,
          pendingPeriodStartedAt: undefined,
        } satisfies SubscriptionRecord

        if (
          currentRecord &&
          currentRecord.pendingPeriod !== undefined &&
          currentRecord.pendingPeriod !== periodIndex
        ) {
          return { op: 'noop', result: undefined }
        }

        return { op: 'set', result: undefined, value: merged }
      })
    },

    async get(subscriptionId) {
      return (await store.get(recordKey(subscriptionId))) as SubscriptionRecord | null
    },

    /** Looks up the single subscription for an identity+resource pair. */
    async getActive(identityId, resourceId) {
      const id = (await store.get(resourceKey(identityId, resourceId))) as string | null
      if (!id) return null
      return (await store.get(recordKey(id))) as SubscriptionRecord | null
    },

    async markCanceled(subscriptionId, cancelEffectiveAt) {
      return store.update(recordKey(subscriptionId), (current) => {
        const currentRecord = current as SubscriptionRecord | null
        if (!currentRecord) return { op: 'noop', result: null }
        const next = { ...currentRecord, cancelEffectiveAt } satisfies SubscriptionRecord
        return { op: 'set', result: next, value: next }
      })
    },

    async markRevoked(subscriptionId, revokedAt) {
      return store.update(recordKey(subscriptionId), (current) => {
        const currentRecord = current as SubscriptionRecord | null
        if (!currentRecord) return { op: 'noop', result: null }
        const next = {
          ...currentRecord,
          pendingPeriod: undefined,
          pendingPeriodStartedAt: undefined,
          revokedAt,
        } satisfies SubscriptionRecord
        return { op: 'set', result: next, value: next }
      })
    },

    async save(record) {
      await store.put(recordKey(record.subscriptionId), record)
    },
  }
}

export declare namespace fromStore {
  type Options = {
    /** Key prefix for subscription records. @default `'tempo:subscription:record:'` */
    recordPrefix?: string | undefined
    /** Timeout after which an in-flight capture claim can be stolen. @default `300000` */
    pendingTimeoutMs?: number | undefined
    /** Key prefix for identity→resource indexes. @default `'tempo:subscription:resource:'` */
    resourcePrefix?: string | undefined
  }
}
