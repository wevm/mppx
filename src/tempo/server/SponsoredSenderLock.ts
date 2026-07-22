import type { Client } from 'viem'
import { getTransaction, getTransactionReceipt } from 'viem/actions'

import * as Store from '../../Store.js'

const defaultLeaseTimeoutMs = 60_000

export type SponsoredSenderLock = {
  createdAt: number
  inputHash: `0x${string}`
  leaseUntil: number
  nonce: string
  nonceKey: string
  owner: string
  phase: 'preparing'
  version: 1
  validBefore: number
}

export type PreparedSponsoredSenderLock = Omit<SponsoredSenderLock, 'leaseUntil' | 'phase'> & {
  phase: 'prepared'
  transactionHash: `0x${string}`
}

export type SponsoredSenderLockRecord = SponsoredSenderLock | PreparedSponsoredSenderLock

export type SponsorshipEvent =
  | (SponsorshipEventBase & { type: 'acquired' })
  | (SponsorshipEventBase & { ageMs: number; type: 'contended' })
  | (SponsorshipEventBase & { transactionHash: `0x${string}`; type: 'prepared' })
  | (SponsorshipEventBase & {
      status: 'pending' | 'reverted' | 'success' | 'unknown'
      type: 'reconciled'
    })
  | (SponsorshipEventBase & {
      reason:
        | 'expired'
        | 'legacy-expired'
        | 'manual'
        | 'pre-broadcast-failure'
        | 'submitted'
        | 'terminal'
      type: 'cleared'
    })

type SponsorshipEventBase = {
  chainId: number
  owner?: string | undefined
  sender: `0x${string}`
}

type StoreItemMap = {
  [key: `mppx:charge:${string}`]: number | SponsoredSenderLockRecord
}

type LockTarget = {
  chainId: number
  sender: `0x${string}`
}

type CommonParameters = LockTarget & {
  onEvent?: ((event: SponsorshipEvent) => void | Promise<void>) | undefined
  store: Store.AtomicStore<StoreItemMap>
}

export type AcquireParameters = CommonParameters & {
  inputHash: `0x${string}`
  leaseTimeoutMs?: number | undefined
  nonce: string
  nonceKey: string
  validBefore: number
}

export type AcquireResult =
  | { lock: SponsoredSenderLock; status: 'acquired' }
  | { ageMs: number; lock: SponsoredSenderLockRecord | number; status: 'contended' }

export type RecoverSponsoredSenderLockParameters = LockTarget & {
  client: Client
  /** Maximum age of legacy timestamp-only locks. @default 60000 */
  leaseTimeoutMs?: number | undefined
  /** Receives best-effort lock lifecycle events. */
  onEvent?: ((event: SponsorshipEvent) => void | Promise<void>) | undefined
  store: Store.AtomicStore
  /** Prefix used by the charge method that owns the lock. */
  storeKeyPrefix?: string | undefined
}

export type RecoverSponsoredSenderLockResult =
  | { status: 'absent' }
  | { ageMs: number; status: 'active' }
  | { ageMs: number; status: 'unknown'; transactionHash: `0x${string}` }
  | {
      reason: 'expired' | 'legacy-expired' | 'pending' | 'reverted' | 'success'
      status: 'cleared'
    }

/**
 * Reconciles one persisted sponsored-sender lock without force-deleting an
 * active or ambiguous transaction. Calling this repeatedly is safe.
 */
export async function recoverSponsoredSenderLock(
  parameters: RecoverSponsoredSenderLockParameters,
): Promise<RecoverSponsoredSenderLockResult> {
  const store = Store.from(parameters.store as Store.AtomicStore<StoreItemMap>, {
    keyPrefix: parameters.storeKeyPrefix ?? '',
  })
  return reconcile({
    chainId: parameters.chainId,
    client: parameters.client,
    leaseTimeoutMs: parameters.leaseTimeoutMs,
    onEvent: parameters.onEvent,
    sender: parameters.sender,
    store,
  })
}

/** @internal */
export async function acquire(parameters: AcquireParameters): Promise<AcquireResult> {
  const now = Date.now()
  const leaseTimeoutMs = parameters.leaseTimeoutMs ?? defaultLeaseTimeoutMs
  const lock: SponsoredSenderLock = {
    createdAt: now,
    inputHash: parameters.inputHash,
    leaseUntil: Math.min(now + leaseTimeoutMs, parameters.validBefore),
    nonce: parameters.nonce,
    nonceKey: parameters.nonceKey,
    owner: crypto.randomUUID(),
    phase: 'preparing',
    validBefore: parameters.validBefore,
    version: 1,
  }
  const result: AcquireResult = await parameters.store.update(
    getStoreKey(parameters),
    (current): Store.Change<number | SponsoredSenderLockRecord, AcquireResult> => {
      if (current === null || isExpired(current, now, leaseTimeoutMs))
        return { op: 'set', result: { lock, status: 'acquired' } as const, value: lock }
      return {
        op: 'noop',
        result: { ageMs: getAge(current, now), lock: current, status: 'contended' } as const,
      }
    },
  )
  if (result.status === 'acquired')
    await emit(parameters, { ...eventBase(parameters, lock.owner), type: 'acquired' })
  else
    await emit(parameters, {
      ...eventBase(parameters, typeof result.lock === 'number' ? undefined : result.lock.owner),
      ageMs: result.ageMs,
      type: 'contended',
    })
  return result
}

/** @internal */
export async function prepare(
  parameters: CommonParameters & {
    lock: SponsoredSenderLock
    transactionHash: `0x${string}`
  },
): Promise<PreparedSponsoredSenderLock | null> {
  const { leaseUntil: _, ...lock } = parameters.lock
  const prepared: PreparedSponsoredSenderLock = {
    ...lock,
    phase: 'prepared',
    transactionHash: parameters.transactionHash,
  }
  const updated = await parameters.store.update(getStoreKey(parameters), (current) => {
    if (!isOwned(current, parameters.lock.owner)) return { op: 'noop', result: false }
    return { op: 'set', result: true, value: prepared }
  })
  if (!updated) return null
  await emit(parameters, {
    ...eventBase(parameters, prepared.owner),
    transactionHash: prepared.transactionHash,
    type: 'prepared',
  })
  return prepared
}

/** @internal */
export async function clear(
  parameters: CommonParameters & {
    lock: SponsoredSenderLockRecord
    reason: Extract<SponsorshipEvent, { type: 'cleared' }>['reason']
  },
): Promise<boolean> {
  const cleared = await parameters.store.update(getStoreKey(parameters), (current) => {
    if (!isOwned(current, parameters.lock.owner)) return { op: 'noop', result: false }
    return { op: 'delete', result: true }
  })
  if (cleared)
    await emit(parameters, {
      ...eventBase(parameters, parameters.lock.owner),
      reason: parameters.reason,
      type: 'cleared',
    })
  return cleared
}

/** @internal */
export async function reconcile(
  parameters: CommonParameters & {
    client: Client
    leaseTimeoutMs?: number | undefined
  },
): Promise<RecoverSponsoredSenderLockResult> {
  const current = await parameters.store.get(getStoreKey(parameters))
  if (current === null) return { status: 'absent' }

  const now = Date.now()
  const leaseTimeoutMs = parameters.leaseTimeoutMs ?? defaultLeaseTimeoutMs
  const ageMs = getAge(current, now)
  if (typeof current === 'number') {
    if (!isExpired(current, now, leaseTimeoutMs)) return { ageMs, status: 'active' }
    const cleared = await clearLegacy(parameters, current)
    if (!cleared) return reconcile(parameters)
    await emit(parameters, {
      ...eventBase(parameters),
      reason: 'legacy-expired',
      type: 'cleared',
    })
    return { reason: 'legacy-expired', status: 'cleared' }
  }

  if (current.phase === 'preparing') {
    if (!isExpired(current, now, leaseTimeoutMs)) return { ageMs, status: 'active' }
    const cleared = await clear({ ...parameters, lock: current, reason: 'expired' })
    if (!cleared) return reconcile(parameters)
    return { reason: 'expired', status: 'cleared' }
  }

  const receipt = await findReceipt(parameters.client, current.transactionHash)
  if (receipt) {
    const status = receipt.status === 'success' ? 'success' : 'reverted'
    await emit(parameters, {
      ...eventBase(parameters, current.owner),
      status,
      type: 'reconciled',
    })
    await markSubmittedHashes(parameters.store, current)
    const cleared = await clear({ ...parameters, lock: current, reason: 'terminal' })
    if (!cleared) return reconcile(parameters)
    return { reason: status, status: 'cleared' }
  }

  const pending = await findTransaction(parameters.client, current.transactionHash)
  if (pending) {
    await emit(parameters, {
      ...eventBase(parameters, current.owner),
      status: 'pending',
      type: 'reconciled',
    })
    await markSubmittedHashes(parameters.store, current)
    const cleared = await clear({ ...parameters, lock: current, reason: 'submitted' })
    if (!cleared) return reconcile(parameters)
    return { reason: 'pending', status: 'cleared' }
  }

  if (now >= current.validBefore) {
    const cleared = await clear({ ...parameters, lock: current, reason: 'expired' })
    if (!cleared) return reconcile(parameters)
    return { reason: 'expired', status: 'cleared' }
  }

  await emit(parameters, {
    ...eventBase(parameters, current.owner),
    status: 'unknown',
    type: 'reconciled',
  })
  return { ageMs, status: 'unknown', transactionHash: current.transactionHash }
}

function getStoreKey(parameters: LockTarget): `mppx:charge:${string}` {
  return `mppx:charge:sponsor:${parameters.chainId}:${parameters.sender.toLowerCase()}`
}

function eventBase(parameters: LockTarget, owner?: string): SponsorshipEventBase {
  return {
    chainId: parameters.chainId,
    ...(owner ? { owner } : {}),
    sender: parameters.sender,
  }
}

function getAge(lock: SponsoredSenderLockRecord | number, now: number) {
  return Math.max(0, now - (typeof lock === 'number' ? lock : lock.createdAt))
}

function isExpired(lock: SponsoredSenderLockRecord | number, now: number, legacyTimeoutMs: number) {
  if (typeof lock === 'number') return now - lock >= legacyTimeoutMs
  if (lock.phase === 'prepared') return now >= lock.validBefore
  return now >= lock.leaseUntil
}

function isOwned(
  lock: SponsoredSenderLockRecord | number | null,
  owner: string,
): lock is SponsoredSenderLockRecord {
  return typeof lock === 'object' && lock !== null && lock.owner === owner
}

async function clearLegacy(parameters: CommonParameters, expected: number) {
  return parameters.store.update(getStoreKey(parameters), (current) => {
    if (current !== expected) return { op: 'noop', result: false }
    return { op: 'delete', result: true }
  })
}

async function markSubmittedHashes(
  store: Store.AtomicStore<StoreItemMap>,
  lock: PreparedSponsoredSenderLock,
) {
  for (const hash of new Set([lock.inputHash, lock.transactionHash]))
    await store.update(`mppx:charge:${hash.toLowerCase()}`, (current) => {
      if (current !== null) return { op: 'noop', result: undefined }
      return { op: 'set', result: undefined, value: Date.now() }
    })
}

async function findReceipt(client: Client, hash: `0x${string}`) {
  try {
    return await getTransactionReceipt(client, { hash })
  } catch {
    return null
  }
}

async function findTransaction(client: Client, hash: `0x${string}`) {
  try {
    return await getTransaction(client, { hash })
  } catch {
    return null
  }
}

async function emit(parameters: Pick<CommonParameters, 'onEvent'>, event: SponsorshipEvent) {
  try {
    await parameters.onEvent?.(event)
  } catch {}
}
