import type { Hex } from 'viem'

import type * as Store from '../../Store.js'

export type Phase = 'broadcasting' | 'pending' | 'prepared'

export type ExpectedTransfer = {
  amount: string
  allowAnyMemo?: boolean | undefined
  memo?: Hex | undefined
  recipient: Hex
}

export type Reservation = {
  amount: string
  challengeBoundMemo: boolean
  challengeId: string
  currency: Hex
  expiresAt: number
  leaseUntil: number
  owner: string
  phase: Phase
  realm: string
  sender: Hex
  transactionHash: Hex
  transfers: readonly ExpectedTransfer[]
}

export type State = {
  debt: string
  reservations: Record<string, Reservation>
  version: 1
}

export type Handle = {
  chainId: number
  id: string
  owner: string
  payer: Hex
  scope: string
}

export type Outcome = 'failed' | 'pending' | 'success'

export type ItemMap = {
  [key: `mppx:charge:credit:${string}`]: State
}

type ReserveParameters = Handle & {
  amount: bigint
  expiresAt: number
  getOutcome: (reservation: Reservation) => Promise<Outcome>
  maxExposure: bigint
  payment: Pick<
    Reservation,
    | 'challengeBoundMemo'
    | 'challengeId'
    | 'currency'
    | 'realm'
    | 'sender'
    | 'transactionHash'
    | 'transfers'
  >
}

const preparedLeaseMs = 30_000

function key(parameters: Pick<Handle, 'chainId' | 'payer' | 'scope'>) {
  return `mppx:charge:credit:${parameters.chainId}:${parameters.scope}:${parameters.payer.toLowerCase()}` as const
}

function isState(value: State | null): value is State {
  return (
    value?.version === 1 && typeof value.debt === 'string' && typeof value.reservations === 'object'
  )
}

function exposure(state: State) {
  return Object.values(state.reservations).reduce(
    (total, reservation) => total + BigInt(reservation.amount),
    BigInt(state.debt),
  )
}

async function mutateOwned(
  store: Store.AtomicStore<ItemMap>,
  handle: Handle,
  mutate: (reservation: Reservation, state: State) => State | null,
) {
  return store.update(key(handle), (current) => {
    if (!isState(current)) return { op: 'noop', result: false }
    const reservation = current.reservations[handle.id]
    if (!reservation || reservation.owner !== handle.owner) return { op: 'noop', result: false }

    const next = mutate(reservation, current)
    if (!next || (next.debt === '0' && Object.keys(next.reservations).length === 0))
      return { op: 'delete', result: true }
    return { op: 'set', value: next, result: true }
  })
}

async function resolve(
  store: Store.AtomicStore<ItemMap>,
  handle: Handle,
  reservation: Reservation,
  outcome: Exclude<Outcome, 'pending'>,
) {
  return store.update(key(handle), (current) => {
    if (!isState(current)) return { op: 'noop', result: false }
    const latest = current.reservations[handle.id]
    if (
      !latest ||
      latest.owner !== reservation.owner ||
      latest.phase !== 'pending' ||
      latest.transactionHash.toLowerCase() !== reservation.transactionHash.toLowerCase()
    )
      return { op: 'noop', result: false }

    const reservations = { ...current.reservations }
    delete reservations[handle.id]
    const debt =
      outcome === 'failed'
        ? (BigInt(current.debt) + BigInt(reservation.amount)).toString()
        : current.debt
    if (debt === '0' && Object.keys(reservations).length === 0)
      return { op: 'delete', result: true }
    return {
      op: 'set',
      value: { debt, reservations, version: 1 },
      result: true,
    }
  })
}

/** Reconciles terminal optimistic charges before making another credit decision. */
export async function reconcile(
  store: Store.AtomicStore<ItemMap>,
  parameters: Pick<ReserveParameters, 'chainId' | 'getOutcome' | 'payer' | 'scope'>,
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
        payer: parameters.payer,
        scope: parameters.scope,
      }
      if (
        (reservation.phase === 'prepared' && reservation.leaseUntil <= now) ||
        (reservation.phase === 'broadcasting' && reservation.expiresAt <= now)
      ) {
        await release(store, handle)
        return
      }
      if (reservation.phase !== 'pending') return

      const outcome = await parameters.getOutcome(reservation)
      if (outcome !== 'pending') await resolve(store, handle, reservation, outcome)
    }),
  )
}

/**
 * Reserves bounded payee exposure for an optimistic charge.
 *
 * A `null` result means the caller must confirm the charge before serving the
 * resource. Explicitly failed optimistic charges remain as debt and consume
 * capacity; successful charges release their reservation during reconciliation.
 *
 * @internal
 */
export async function reserve(
  store: Store.AtomicStore<ItemMap>,
  parameters: ReserveParameters,
): Promise<Handle | null> {
  await reconcile(store, parameters)
  const now = Date.now()
  const result = await store.update(key(parameters), (current) => {
    if (current !== null && !isState(current)) return { op: 'noop', result: 'invalid' as const }

    const state = current ?? { debt: '0', reservations: {}, version: 1 as const }
    if (state.reservations[parameters.id]) return { op: 'noop', result: 'duplicate' as const }
    if (exposure(state) + parameters.amount > parameters.maxExposure)
      return { op: 'noop', result: 'confirm' as const }

    return {
      op: 'set',
      value: {
        ...state,
        reservations: {
          ...state.reservations,
          [parameters.id]: {
            amount: parameters.amount.toString(),
            expiresAt: parameters.expiresAt,
            leaseUntil: Math.min(parameters.expiresAt, now + preparedLeaseMs),
            owner: parameters.owner,
            phase: 'prepared' as const,
            ...parameters.payment,
          },
        },
      },
      result: 'reserved' as const,
    }
  })

  if (result === 'reserved') return parameters
  if (result === 'confirm') return null
  if (result === 'invalid') throw new Error('Charge credit store contains incompatible state')
  throw new Error('Charge already has a credit reservation')
}

/** Advances an owned reservation around the transaction broadcast. @internal */
export async function transition(
  store: Store.AtomicStore<ItemMap>,
  handle: Handle,
  phase: Exclude<Phase, 'prepared'>,
): Promise<boolean> {
  return mutateOwned(store, handle, (reservation, state) => ({
    ...state,
    reservations: {
      ...state.reservations,
      [handle.id]: { ...reservation, phase },
    },
  }))
}

/** Releases an owned reservation when no resource was served. @internal */
export async function release(store: Store.AtomicStore<ItemMap>, handle: Handle): Promise<boolean> {
  return mutateOwned(store, handle, (_reservation, state) => {
    const reservations = { ...state.reservations }
    delete reservations[handle.id]
    return { ...state, reservations }
  })
}

/** Returns the current bounded-credit state for diagnostics and tests. @internal */
export async function getState(
  store: Store.AtomicStore<ItemMap>,
  parameters: Pick<Handle, 'chainId' | 'payer' | 'scope'>,
): Promise<State | null> {
  const state = await store.get(key(parameters))
  return isState(state) ? state : null
}
