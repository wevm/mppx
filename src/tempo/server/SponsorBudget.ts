import type { Hex } from 'viem'

import { VerificationFailedError } from '../../Errors.js'
import type * as Store from '../../Store.js'

export type Phase = 'prepared' | 'broadcasting' | 'pending'

export type Reservation = {
  expiresAt: number
  fee: string
  leaseUntil: number
  owner: string
  phase: Phase
  transactionHash: Hex
}

export type State = {
  reservations: Record<string, Reservation>
  version: 1
}

export type Handle = {
  chainId: number
  id: string
  owner: string
  sponsor: Hex
}

type ItemMap = {
  [key: `mppx:charge:sponsor-budget:${string}`]: State
}

type ReserveParameters = Handle & {
  expiresAt: number
  fee: bigint
  getReceipt: (hash: Hex) => Promise<unknown>
  maxReservations: number
  maxTotalFee: bigint
  transactionHash: Hex
  waitUntil: number
}

const initialPollIntervalMs = 10
const maxPollIntervalMs = 250
const preparedLeaseMs = 30_000

function key(parameters: Pick<Handle, 'chainId' | 'sponsor'>) {
  return `mppx:charge:sponsor-budget:${parameters.chainId}:${parameters.sponsor.toLowerCase()}` as const
}

function isState(value: State | null): value is State {
  return value?.version === 1 && typeof value.reservations === 'object'
}

async function mutateOwned(
  store: Store.AtomicStore<ItemMap>,
  handle: Handle,
  mutate: (reservation: Reservation) => Reservation | null,
) {
  return store.update(key(handle), (current) => {
    if (!isState(current)) return { op: 'noop', result: false }
    const reservation = current.reservations[handle.id]
    if (!reservation || reservation.owner !== handle.owner) return { op: 'noop', result: false }

    const reservations = { ...current.reservations }
    const next = mutate(reservation)
    if (next) reservations[handle.id] = next
    else delete reservations[handle.id]

    if (Object.keys(reservations).length === 0) return { op: 'delete', result: true }
    return {
      op: 'set',
      value: { reservations, version: 1 },
      result: true,
    }
  })
}

async function reconcile(
  store: Store.AtomicStore<ItemMap>,
  parameters: Pick<ReserveParameters, 'chainId' | 'getReceipt' | 'sponsor'>,
) {
  const state = await store.get(key(parameters))
  if (!isState(state)) return

  const now = Date.now()
  await Promise.all(
    Object.entries(state.reservations).map(async ([id, reservation]) => {
      const handle = {
        chainId: parameters.chainId,
        id,
        owner: reservation.owner,
        sponsor: parameters.sponsor,
      }
      if (
        reservation.expiresAt <= now ||
        (reservation.phase === 'prepared' && reservation.leaseUntil <= now)
      ) {
        await release(store, handle)
        return
      }
      if (reservation.phase === 'prepared') return

      try {
        await parameters.getReceipt(reservation.transactionHash)
      } catch {
        return
      }
      await release(store, handle)
    }),
  )
}

/**
 * Reserves aggregate sponsor fee capacity across processes.
 *
 * Pending broadcasts remain charged to the budget until a receipt is observed
 * or their expiring nonce becomes invalid. Capacity waiters do not rewrite the
 * shared state while waiting.
 *
 * @internal
 */
export async function reserve(
  store: Store.AtomicStore<ItemMap>,
  parameters: ReserveParameters,
): Promise<Handle> {
  if (parameters.fee > parameters.maxTotalFee)
    throw new VerificationFailedError({
      reason: 'Sponsored transaction fee exceeds the aggregate sponsor budget',
    })

  let pollIntervalMs = initialPollIntervalMs
  for (;;) {
    const now = Date.now()
    if (now >= parameters.waitUntil)
      throw new VerificationFailedError({
        reason: 'Sponsored transaction expired while waiting for sponsor budget',
      })

    await reconcile(store, parameters)
    const result = await store.update(key(parameters), (current) => {
      if (current !== null && !isState(current)) return { op: 'noop', result: 'invalid' as const }

      const reservations = { ...(current?.reservations ?? {}) }
      const existing = reservations[parameters.id]
      if (existing) return { op: 'noop', result: 'duplicate' as const }

      const values = Object.values(reservations)
      const totalFee = values.reduce((total, reservation) => total + BigInt(reservation.fee), 0n)
      if (
        values.length >= parameters.maxReservations ||
        totalFee + parameters.fee > parameters.maxTotalFee
      )
        return { op: 'noop', result: 'wait' as const }

      reservations[parameters.id] = {
        expiresAt: parameters.expiresAt,
        fee: parameters.fee.toString(),
        leaseUntil: Math.min(parameters.expiresAt, now + preparedLeaseMs),
        owner: parameters.owner,
        phase: 'prepared',
        transactionHash: parameters.transactionHash,
      }
      return {
        op: 'set',
        value: { reservations, version: 1 },
        result: 'reserved' as const,
      }
    })

    if (result === 'reserved') return parameters
    if (result === 'invalid')
      throw new VerificationFailedError({
        reason: 'Sponsor budget store contains incompatible state',
      })
    if (result === 'duplicate')
      throw new VerificationFailedError({
        reason: 'Sponsored transaction already has a budget reservation',
      })

    await new Promise((resolve) =>
      setTimeout(resolve, Math.min(pollIntervalMs, parameters.waitUntil - now)),
    )
    pollIntervalMs = Math.min(pollIntervalMs * 2, maxPollIntervalMs)
  }
}

/**
 * Advances a reservation before and after the broadcast call.
 *
 * The owner token fences stale workers from mutating a replacement reservation.
 *
 * @internal
 */
export async function transition(
  store: Store.AtomicStore<ItemMap>,
  handle: Handle,
  phase: Exclude<Phase, 'prepared'>,
): Promise<boolean> {
  return mutateOwned(store, handle, (reservation) => ({
    ...reservation,
    phase,
  }))
}

/**
 * Releases a reservation only when the caller still owns it.
 *
 * @internal
 */
export async function release(store: Store.AtomicStore<ItemMap>, handle: Handle): Promise<boolean> {
  return mutateOwned(store, handle, () => null)
}
