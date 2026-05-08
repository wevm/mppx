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
const defaultRenewalTimeoutMs = 15 * 60 * 1_000

/** Subscription-aware wrapper around a generic key-value store. */
export type SubscriptionStore = {
  /** Runs activation once for a challenge and resolved lookup key. */
  activate<result extends { subscription: SubscriptionRecord }>(
    parameters: ActivateParameters<result>,
  ): Promise<ActivateResult<result>>
  /** Looks up a subscription by subscription ID. */
  get(subscriptionId: string): Promise<SubscriptionRecord | null>
  /** Looks up a generated access key for a resolved request key. */
  getAccessKey(key: string): Promise<SubscriptionAccessKeyRecord | null>
  /** Looks up the active subscription for a resolved request key. */
  getByKey(key: string): Promise<SubscriptionRecord | null>
  /** Gets or creates the server-owned access key for a resolved request key. */
  getOrCreateAccessKey(key: string): Promise<SubscriptionAccessKeyRecord>
  /** Upserts a subscription record and marks it as active for its lookup key. */
  put(record: SubscriptionRecord): Promise<void>
  /** Runs renewal once for a subscription period. */
  renew<result extends { subscription: SubscriptionRecord }>(
    parameters: RenewParameters<result>,
  ): Promise<RenewResult<result>>
}

type ActivateParameters<result extends { subscription: SubscriptionRecord }> = {
  challengeId: string
  create: () => Promise<result>
  isReusable?: ((subscription: SubscriptionRecord) => boolean) | undefined
  lookupKey: string
}

export type ActivateResult<result extends { subscription: SubscriptionRecord }> =
  | { status: 'activated'; result: result }
  | { status: 'claimMismatch' }
  | { status: 'existing'; subscription: SubscriptionRecord }
  | { status: 'inFlight' }
  | { status: 'replayed' }

type RenewParameters<result extends { subscription: SubscriptionRecord }> = {
  inFlightReference: string
  periodIndex: number
  renew: (parameters: {
    inFlightReference: string
    periodIndex: number
    subscription: SubscriptionRecord
  }) => Promise<result>
  subscriptionId: string
}

export type RenewResult<result extends { subscription: SubscriptionRecord }> =
  | { status: 'charged'; subscription: SubscriptionRecord }
  | { status: 'inFlight'; subscription: SubscriptionRecord }
  | { status: 'missing' }
  | { status: 'renewed'; result: result }
  | { status: 'claimMismatch' }

type ActivationMarker = {
  challengeId?: string
  startedAt?: string
}

/** Wraps a generic key-value {@link Store.Store} with subscription-specific accessors. */
export function fromStore(
  store: Store.AtomicStore<Record<string, unknown>>,
  options?: fromStore.Options,
): SubscriptionStore {
  const {
    accessKeyPrefix = defaultAccessKeyPrefix,
    activationPrefix = defaultActivationPrefix,
    activationTimeoutMs = defaultActivationTimeoutMs,
    credentialPrefix = defaultCredentialPrefix,
    keyPrefix = defaultKeyPrefix,
    recordPrefix = defaultRecordPrefix,
    renewalTimeoutMs = defaultRenewalTimeoutMs,
  } = options ?? {}

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

  function lookupRecordKey(key: string): string {
    return `${keyPrefix}${key}`
  }

  async function getByLookupKey(key: string): Promise<SubscriptionRecord | null> {
    const subscriptionId = (await store.get(lookupRecordKey(key))) as string | null
    if (!subscriptionId) return null
    return (await store.get(recordKey(subscriptionId))) as SubscriptionRecord | null
  }

  async function clearRenewalState(subscriptionId: string, periodIndex: number) {
    await store.update(recordKey(subscriptionId), (current) => {
      const subscription = current as SubscriptionRecord | null
      if (!subscription || subscription.inFlightPeriod !== periodIndex) {
        return { op: 'noop', result: undefined }
      }
      return {
        op: 'set',
        value: clearRenewal(subscription),
        result: undefined,
      }
    })
  }

  return {
    async activate({ challengeId, create, isReusable, lookupKey }) {
      const claimed = await store.update(credentialKey(challengeId), (current) => {
        if (current) return { op: 'noop', result: false }
        return {
          op: 'set',
          value: { claimedAt: timestamp() },
          result: true,
        }
      })
      if (!claimed) return { status: 'replayed' }

      const existing = await getByLookupKey(lookupKey)
      if (existing && isReusable?.(existing)) {
        return { status: 'existing', subscription: existing }
      }

      const started = await store.update(
        activationKey(lookupKey),
        (current): Store.Change<unknown, { status: 'started' } | { status: 'inFlight' }> => {
          const marker = current as ActivationMarker | null
          if (marker && !isStaleActivation(marker, activationTimeoutMs)) {
            return { op: 'noop', result: { status: 'inFlight' as const } }
          }
          return {
            op: 'set',
            value: {
              challengeId,
              startedAt: timestamp(),
            },
            result: { status: 'started' as const },
          }
        },
      )
      if (started.status !== 'started') return { status: 'inFlight' }

      const result = await create().catch(async (error) => {
        await store.update(activationKey(lookupKey), (current) => {
          const marker = current as ActivationMarker | null
          if (marker?.challengeId !== challengeId) return { op: 'noop', result: undefined }
          return { op: 'delete', result: undefined }
        })
        throw error
      })
      const { subscription } = result
      const committed = await store.update(activationKey(subscription.lookupKey), (current) => {
        const marker = current as ActivationMarker | null
        if (marker?.challengeId !== challengeId) return { op: 'noop', result: false }
        return {
          op: 'set',
          value: { ...marker, committingAt: timestamp() },
          result: true,
        }
      })
      if (!committed) return { status: 'claimMismatch' }

      await store.put(recordKey(subscription.subscriptionId), subscription)
      await store.put(lookupRecordKey(subscription.lookupKey), subscription.subscriptionId)
      await store.update(activationKey(subscription.lookupKey), (current) => {
        const marker = current as ActivationMarker | null
        if (marker?.challengeId !== challengeId) return { op: 'noop', result: undefined }
        return { op: 'delete', result: undefined }
      })
      return { status: 'activated', result }
    },

    async get(subscriptionId) {
      return (await store.get(recordKey(subscriptionId))) as SubscriptionRecord | null
    },

    async getAccessKey(key) {
      return (await store.get(accessKeyKey(key))) as SubscriptionAccessKeyRecord | null
    },

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

    async put(record) {
      await store.put(recordKey(record.subscriptionId), record)
      await store.put(lookupRecordKey(record.lookupKey), record.subscriptionId)
    },

    async renew({ inFlightReference, periodIndex, renew, subscriptionId }) {
      const started = await store.update(
        recordKey(subscriptionId),
        (
          current,
        ): Store.Change<
          unknown,
          | { status: 'started'; subscription: SubscriptionRecord }
          | { status: 'charged'; subscription: SubscriptionRecord }
          | { status: 'inFlight'; subscription: SubscriptionRecord }
          | { status: 'missing' }
        > => {
          const subscription = current as SubscriptionRecord | null
          if (!subscription) return { op: 'noop', result: { status: 'missing' as const } }
          if (subscription.lastChargedPeriod >= periodIndex) {
            return {
              op: 'noop',
              result: { status: 'charged' as const, subscription },
            }
          }
          if (
            subscription.inFlightPeriod === periodIndex &&
            !isStaleRenewal(subscription, renewalTimeoutMs)
          ) {
            return {
              op: 'noop',
              result: { status: 'inFlight' as const, subscription },
            }
          }

          const next = {
            ...subscription,
            inFlightPeriod: periodIndex,
            inFlightReference,
            inFlightStartedAt: timestamp(),
          }
          return {
            op: 'set',
            value: next,
            result: { status: 'started' as const, subscription: next },
          }
        },
      )
      if (started.status !== 'started') return started

      const result = await renew({
        inFlightReference,
        periodIndex,
        subscription: started.subscription,
      }).catch(async (error) => {
        await clearRenewalState(subscriptionId, periodIndex)
        throw error
      })

      const committed = await store.update(recordKey(subscriptionId), (current) => {
        const existing = current as SubscriptionRecord | null
        if (!existing || existing.inFlightPeriod !== periodIndex) {
          return { op: 'noop', result: false }
        }

        const terminal = {
          ...(existing.canceledAt ? { canceledAt: existing.canceledAt } : {}),
          ...(existing.revokedAt ? { revokedAt: existing.revokedAt } : {}),
        }
        return {
          op: 'set',
          value: clearRenewal({
            ...result.subscription,
            ...terminal,
            lastChargedPeriod: periodIndex,
            subscriptionId,
          }),
          result: true,
        }
      })
      if (!committed) return { status: 'claimMismatch' }

      await store.put(lookupRecordKey(result.subscription.lookupKey), subscriptionId)
      return { status: 'renewed', result }
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
    /** Milliseconds before a stuck renewal lock can be replaced. @default `900000` */
    renewalTimeoutMs?: number | undefined
    /** Key prefix for resolved request keys. @default `'tempo:subscription:key:'` */
    keyPrefix?: string | undefined
  }
}

function isStaleActivation(marker: { startedAt?: string | undefined }, timeoutMs: number) {
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) return false
  const startedAt = new Date(marker.startedAt ?? '').getTime()
  if (!Number.isFinite(startedAt)) return true
  return Date.now() - startedAt >= timeoutMs
}

function isStaleRenewal(subscription: SubscriptionRecord, timeoutMs: number) {
  return isStaleActivation({ startedAt: subscription.inFlightStartedAt }, timeoutMs)
}

function clearRenewal(subscription: SubscriptionRecord): SubscriptionRecord {
  return {
    ...subscription,
    inFlightPeriod: undefined,
    inFlightReference: undefined,
    inFlightStartedAt: undefined,
  }
}

function timestamp() {
  return new Date().toISOString()
}
