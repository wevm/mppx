import { Secp256k1 } from 'ox'
import { Account as TempoAccount } from 'viem/tempo'

import * as Store from '../../Store.js'
import type { SubscriptionAccessKeyRecord, SubscriptionRecord } from './Types.js'

const defaultRecordPrefix = 'tempo:subscription:record:'
const defaultKeyPrefix = 'tempo:subscription:key:'
const defaultActivationPrefix = 'tempo:subscription:activation:'
const defaultAccessKeyPrefix = 'tempo:subscription:access-key:'
const defaultCredentialPrefix = 'tempo:subscription:credential:'
const defaultActivationTimeoutMs = 15 * 60 * 1_000

/** Subscription-aware wrapper around a generic key-value store. */
export type SubscriptionStore = {
  /** Atomically marks a resolved subscription key as being activated. */
  beginActivation: (lookupKey: string, challengeId: string) => Promise<BeginActivationResult>
  /** Atomically marks a subscription period as being renewed. */
  beginRenewal: (
    subscriptionId: string,
    periodIndex: number,
    inFlightReference?: string | undefined,
  ) => Promise<BeginRenewalResult>
  /** Atomically claims a subscription activation challenge for single-use credentials. */
  claimActivation: (challengeId: string) => Promise<boolean>
  /** Stores an activated subscription and clears its in-flight activation marker. */
  commitActivation: (subscription: SubscriptionRecord, challengeId: string) => Promise<boolean>
  /** Atomically stores a successful renewal and clears the in-flight marker. */
  commitRenewal: (
    subscriptionId: string,
    subscription: SubscriptionRecord,
    periodIndex: number,
  ) => Promise<boolean>
  /** Clears an in-flight renewal marker after a failed renewal attempt. */
  failRenewal: (subscriptionId: string, periodIndex: number) => Promise<void>
  /** Looks up a subscription by subscription ID. */
  get: (subscriptionId: string) => Promise<SubscriptionRecord | null>
  /** Looks up a generated access key for a resolved request key. */
  getAccessKey: (key: string) => Promise<SubscriptionAccessKeyRecord | null>
  /** Looks up the active subscription for a resolved request key. */
  getByKey: (key: string) => Promise<SubscriptionRecord | null>
  /** Gets or creates the server-owned access key for a resolved request key. */
  getOrCreateAccessKey: (key: string) => Promise<SubscriptionAccessKeyRecord>
  /** Upserts a subscription record and marks it as active for its lookup key. */
  put: (record: SubscriptionRecord) => Promise<void>
}

/** Result from attempting to mark a resolved subscription key as in-flight. */
export type BeginActivationResult = { status: 'started' } | { status: 'inFlight' }

/** Result from attempting to mark a subscription period as in-flight. */
export type BeginRenewalResult =
  | { status: 'started'; subscription: SubscriptionRecord }
  | { status: 'charged'; subscription: SubscriptionRecord }
  | { status: 'inFlight'; subscription: SubscriptionRecord }
  | { status: 'missing' }

/** Wraps a generic key-value {@link Store.Store} with subscription-specific accessors. */
export function fromStore(
  store: Store.AtomicStore<Record<string, unknown>>,
  options?: fromStore.Options,
): SubscriptionStore {
  const recordPrefix = options?.recordPrefix ?? defaultRecordPrefix
  const keyPrefix = options?.keyPrefix ?? defaultKeyPrefix
  const activationPrefix = options?.activationPrefix ?? defaultActivationPrefix
  const accessKeyPrefix = options?.accessKeyPrefix ?? defaultAccessKeyPrefix
  const activationTimeoutMs = options?.activationTimeoutMs ?? defaultActivationTimeoutMs
  const credentialPrefix = options?.credentialPrefix ?? defaultCredentialPrefix

  function recordKey(subscriptionId: string): string {
    return `${recordPrefix}${subscriptionId}`
  }

  function activationKey(key: string): string {
    return `${activationPrefix}${key}`
  }

  function credentialKey(challengeId: string): string {
    return `${credentialPrefix}${challengeId}`
  }

  function accessKeyKey(key: string): string {
    return `${accessKeyPrefix}${key}`
  }

  function lookupKey(key: string): string {
    return `${keyPrefix}${key}`
  }

  async function getByLookupKey(key: string): Promise<SubscriptionRecord | null> {
    const id = (await store.get(lookupKey(key))) as string | null
    if (!id) return null
    return (await store.get(recordKey(id))) as SubscriptionRecord | null
  }

  return {
    async beginActivation(key, challengeId) {
      return store.update(
        activationKey(key),
        (current): Store.Change<unknown, BeginActivationResult> => {
          const marker = current as { startedAt?: string } | null
          if (marker && !isStaleActivation(marker, activationTimeoutMs)) {
            return { op: 'noop', result: { status: 'inFlight' as const } }
          }
          return {
            op: 'set',
            value: {
              challengeId,
              startedAt: new Date().toISOString(),
            },
            result: { status: 'started' as const },
          }
        },
      )
    },

    async beginRenewal(subscriptionId, periodIndex, inFlightReference) {
      return store.update(
        recordKey(subscriptionId),
        (current): Store.Change<unknown, BeginRenewalResult> => {
          const subscription = current as SubscriptionRecord | null
          if (!subscription) return { op: 'noop', result: { status: 'missing' as const } }
          if (subscription.lastChargedPeriod >= periodIndex) {
            return {
              op: 'noop',
              result: { status: 'charged' as const, subscription },
            }
          }
          if (subscription.inFlightPeriod === periodIndex) {
            return {
              op: 'noop',
              result: { status: 'inFlight' as const, subscription },
            }
          }

          const next = {
            ...subscription,
            inFlightPeriod: periodIndex,
            inFlightReference,
            inFlightStartedAt: new Date().toISOString(),
          }
          return {
            op: 'set',
            value: next,
            result: { status: 'started' as const, subscription: next },
          }
        },
      )
    },

    async claimActivation(challengeId) {
      return store.update(credentialKey(challengeId), (current) => {
        // Challenge IDs are single-use for activation credentials.
        if (current) return { op: 'noop', result: false }
        return {
          op: 'set',
          value: { claimedAt: new Date().toISOString() },
          result: true,
        }
      })
    },

    async commitActivation(subscription, challengeId) {
      const claimed = await store.update(activationKey(subscription.lookupKey), (current) => {
        const marker = current as { challengeId?: string; startedAt?: string } | null
        if (marker?.challengeId !== challengeId) return { op: 'noop', result: false }
        return {
          op: 'set',
          value: { ...marker, committingAt: new Date().toISOString() },
          result: true,
        }
      })
      if (!claimed) return false

      await store.put(recordKey(subscription.subscriptionId), subscription)
      await store.put(lookupKey(subscription.lookupKey), subscription.subscriptionId)
      await store.update(activationKey(subscription.lookupKey), (current) => {
        const marker = current as { challengeId?: string } | null
        if (marker?.challengeId !== challengeId) return { op: 'noop', result: undefined }
        return { op: 'delete', result: undefined }
      })
      return true
    },

    async commitRenewal(subscriptionId, subscription, periodIndex) {
      const committed = await store.update(recordKey(subscriptionId), (current) => {
        const existing = current as SubscriptionRecord | null
        if (!existing || existing.inFlightPeriod !== periodIndex) {
          return { op: 'noop', result: false }
        }

        return {
          op: 'set',
          value: {
            ...subscription,
            inFlightPeriod: undefined,
            inFlightReference: undefined,
            inFlightStartedAt: undefined,
            lastChargedPeriod: periodIndex,
            subscriptionId,
          },
          result: true,
        }
      })
      if (committed) await store.put(lookupKey(subscription.lookupKey), subscriptionId)
      return committed
    },

    async failRenewal(subscriptionId, periodIndex) {
      await store.update(recordKey(subscriptionId), (current) => {
        const subscription = current as SubscriptionRecord | null
        if (!subscription || subscription.inFlightPeriod !== periodIndex) {
          return { op: 'noop', result: undefined }
        }
        return {
          op: 'set',
          value: {
            ...subscription,
            inFlightPeriod: undefined,
            inFlightReference: undefined,
            inFlightStartedAt: undefined,
          },
          result: undefined,
        }
      })
    },

    async get(subscriptionId) {
      return (await store.get(recordKey(subscriptionId))) as SubscriptionRecord | null
    },

    async getAccessKey(key) {
      return (await store.get(accessKeyKey(key))) as SubscriptionAccessKeyRecord | null
    },

    /** Looks up the active subscription for a resolved request key. */
    async getByKey(key) {
      return getByLookupKey(key)
    },

    async getOrCreateAccessKey(key) {
      const privateKey = Secp256k1.randomPrivateKey()
      const account = TempoAccount.fromSecp256k1(privateKey)
      const candidate = {
        accessKeyAddress: account.address.toLowerCase() as `0x${string}`,
        keyType: account.keyType,
        privateKey,
      } satisfies SubscriptionAccessKeyRecord
      return store.update(
        accessKeyKey(key),
        (current): Store.Change<unknown, SubscriptionAccessKeyRecord> => {
          if (current) {
            return { op: 'noop', result: current as SubscriptionAccessKeyRecord }
          }
          return { op: 'set', value: candidate, result: candidate }
        },
      )
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
    /** Key prefix for server-owned subscription access keys. @default `'tempo:subscription:access-key:'` */
    accessKeyPrefix?: string | undefined
    /** Key prefix for resolved subscription activation locks. @default `'tempo:subscription:activation:'` */
    activationPrefix?: string | undefined
    /** Milliseconds before a stuck activation lock can be replaced. @default `900000` */
    activationTimeoutMs?: number | undefined
    /** Key prefix for single-use activation credential markers. @default `'tempo:subscription:credential:'` */
    credentialPrefix?: string | undefined
    /** Key prefix for subscription records. @default `'tempo:subscription:record:'` */
    recordPrefix?: string | undefined
    /** Key prefix for resolved request keys. @default `'tempo:subscription:key:'` */
    keyPrefix?: string | undefined
  }
}

function isStaleActivation(marker: { startedAt?: string }, timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return false
  const startedAt = new Date(marker.startedAt ?? '').getTime()
  if (!Number.isFinite(startedAt)) return true
  return Date.now() - startedAt >= timeoutMs
}
