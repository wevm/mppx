import type { Hex } from 'viem'

import { ChannelClosedError } from '../../../Errors.js'
import type { NeedVoucherEvent } from '../precompile/Protocol.js'
import * as ChannelStore from './ChannelStore.js'

export const streamReservationTtlMs = 5 * 60_000

/** Parameters for reserving voucher headroom before emitting a stream item. */
export type ReserveChargeParameters = {
  /** Amount required for the next stream item. */
  amount: bigint
  /** Channel being metered. */
  channelId: Hex
  /** Emits the transport-specific need-voucher frame. */
  emit: (message: string) => void | Promise<void>
  /** Formats a transport-specific need-voucher frame. */
  formatNeedVoucher(parameters: NeedVoucherEvent): string
  /** Store polling interval when `waitForUpdate` is unavailable. */
  pollIntervalMs: number
  /** Replace this stream's existing reservation instead of appending another unit. */
  replaceExisting?: boolean | undefined
  /** Stable identifier for this stream's shared reservation. */
  reservationId: string
  /** Optional abort signal for long waits. */
  signal?: AbortSignal | undefined
  /** Channel store used for state reads and waits. */
  store: ChannelStore.ChannelStore
}

/** Parameters for committing previously reserved stream charges. */
export type CommitReservedChargesParameters = {
  /** Channel being metered. */
  channelId: Hex
  /** Stable identifier for this stream's shared reservation. */
  reservationId: string
  /** Aborts and releases the reservation if cancellation wins before the atomic commit. */
  signal?: AbortSignal | undefined
  /** Channel store used for atomic updates. */
  store: ChannelStore.ChannelStore
}

/** Parameters for releasing an unconsumed stream reservation. */
export type ReleaseReservedChargesParameters = Pick<
  CommitReservedChargesParameters,
  'channelId' | 'reservationId' | 'store'
>

/**
 * Reserves voucher headroom for a future stream emission.
 *
 * If the channel lacks headroom, emits one need-voucher frame, then waits for
 * a store update or polling interval until the accepted voucher covers every
 * shared stream reservation and the next requested amount.
 */
export async function reserveChargeOrWait(options: ReserveChargeParameters): Promise<void> {
  const {
    amount,
    channelId,
    emit,
    formatNeedVoucher,
    pollIntervalMs,
    replaceExisting,
    reservationId,
    signal,
    store,
  } = options

  let result = await reserveCharge({ amount, channelId, replaceExisting, reservationId, store })
  if (result.ok) return
  let lastRequiredCumulative: bigint | undefined

  while (!result.ok) {
    const channel = result.channel
    throwIfChannelClosed(channel)
    const existing = replaceExisting ? channel.streamReservations?.[reservationId] : undefined
    const requiredCumulative =
      channel.spent + ChannelStore.reservedStreamAmount(channel) - (existing?.amount ?? 0n) + amount
    if (requiredCumulative !== lastRequiredCumulative) {
      await Promise.resolve(
        emit(
          formatNeedVoucher({
            channelId,
            requiredCumulative: requiredCumulative.toString(),
            acceptedCumulative: channel.highestVoucherAmount.toString(),
            deposit: channel.deposit.toString(),
          }),
        ),
      )
      lastRequiredCumulative = requiredCumulative
    }
    await waitForUpdate(store, channelId, pollIntervalMs, signal)
    result = await reserveCharge({ amount, channelId, replaceExisting, reservationId, store })
  }
}

/** Atomically commits previously reserved stream charges to channel spend and unit counters. */
export async function commitReservedCharges(
  options: CommitReservedChargesParameters,
): Promise<ChannelStore.State> {
  const { channelId, reservationId, signal, store } = options

  let canceled = false
  let committed = false
  let expired = false
  let found = false
  const channel = await store.updateChannel(channelId, (current) => {
    // Store adapters may retry this callback. Only the final attempt determines
    // whether the returned state includes this charge.
    committed = false
    expired = false
    found = false
    if (!current) return null
    if (signal?.aborted) {
      canceled = true
      if (!current.streamReservations?.[reservationId]) return current
      found = true
      return removeStreamReservation(current, reservationId)
    }
    if (current.finalized) return current
    if (current.closeRequestedAt !== 0n) return current
    const reservation = current.streamReservations?.[reservationId]
    if (!reservation) return current
    found = true
    if (reservation.committed) return current
    if (reservation.expiresAt <= Date.now()) {
      expired = true
      return removeStreamReservation(current, reservationId)
    }
    if (current.highestVoucherAmount - current.spent < reservation.amount) return current
    committed = true
    return {
      ...current,
      spent: current.spent + reservation.amount,
      streamReservations: {
        ...current.streamReservations,
        [reservationId]: {
          ...reservation,
          committed: true,
          expiresAt: Date.now() + streamReservationTtlMs,
        },
      },
      units: current.units + reservation.units,
    }
  })

  if (!channel) throw new Error('channel not found')
  if (signal?.aborted && committed) {
    await releaseReservedCharges({ channelId, reservationId, store })
    throw abortReason(signal)
  }
  if (canceled) throw abortReason(signal)
  throwIfChannelClosed(channel)
  if (expired) throw new Error('stream reservation expired before commit')
  if (!found) throw new Error('stream reservation no longer exists')
  if (!committed) throw new Error('reserved voucher coverage is no longer available')
  return channel
}

function abortReason(signal: AbortSignal | undefined): unknown {
  return signal?.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

/** Releases a stream reservation when no value was emitted for it. */
export async function releaseReservedCharges(
  options: ReleaseReservedChargesParameters,
): Promise<void> {
  const { channelId, reservationId, store } = options
  await store.updateChannel(channelId, (current) => {
    const reservation = current?.streamReservations?.[reservationId]
    if (!current || !reservation) return current
    const released = removeStreamReservation(current, reservationId)
    if (!reservation.committed) return released
    if (current.spent < reservation.amount || current.units < reservation.units)
      throw new Error('cannot roll back persisted stream charge')
    return {
      ...released,
      spent: current.spent - reservation.amount,
      units: current.units - reservation.units,
    }
  })
}

/** Clears a committed reservation after its value has been accepted by the transport. */
export async function finalizeCommittedCharges(
  options: ReleaseReservedChargesParameters,
): Promise<ChannelStore.State> {
  const { channelId, reservationId, store } = options
  let finalized = false
  const channel = await store.updateChannel(channelId, (current) => {
    const reservation = current?.streamReservations?.[reservationId]
    if (!current || !reservation?.committed) return current
    finalized = true
    return removeStreamReservation(current, reservationId)
  })
  if (!channel) throw new Error('channel not found')
  if (!finalized) throw new Error('committed stream reservation no longer exists')
  return channel
}

/** Renews an existing response reservation without changing its amount or units. */
export async function renewReservedCharges(
  parameters: ReleaseReservedChargesParameters,
): Promise<void> {
  const { channelId, reservationId, store } = parameters
  await store.updateChannel(channelId, (current) => {
    const now = Date.now()
    const reservation = current?.streamReservations?.[reservationId]
    if (!current || !reservation || current.finalized || current.closeRequestedAt !== 0n)
      return current
    if (reservation.expiresAt <= now) return removeStreamReservation(current, reservationId)
    return {
      ...current,
      streamReservations: {
        ...current.streamReservations,
        [reservationId]: { ...reservation, expiresAt: now + streamReservationTtlMs },
      },
    }
  })
}

/** Renews a reservation until the caller commits or releases it. */
export function maintainReservedCharges(parameters: ReleaseReservedChargesParameters): () => void {
  const timer = setInterval(() => {
    void renewReservedCharges(parameters).catch(() => undefined)
  }, streamReservationTtlMs / 3)
  ;(timer as unknown as { unref?: () => void }).unref?.()
  return () => clearInterval(timer)
}

/** Attempts one atomic stream reservation without waiting for additional voucher headroom. */
export async function reserveCharge(parameters: {
  amount: bigint
  channelId: Hex
  replaceExisting?: boolean | undefined
  reservationId: string
  store: ChannelStore.ChannelStore
}): Promise<{ channel: ChannelStore.State; ok: boolean }> {
  const { amount, channelId, replaceExisting, reservationId, store } = parameters
  if (store.updateChannelResult) {
    const result = await store.updateChannelResult<{
      channel: ChannelStore.State
      ok: boolean
    } | null>(channelId, (current) => {
      if (!current) return { op: 'noop', result: null }
      const now = Date.now()
      const active = removeExpiredStreamReservations(current, now)
      if (active.finalized || active.closeRequestedAt !== 0n)
        return active === current
          ? { op: 'noop', result: { channel: active, ok: false } }
          : { op: 'set', value: active, result: { channel: active, ok: false } }
      const existing = active.streamReservations?.[reservationId]
      const reservedAmount =
        ChannelStore.reservedStreamAmount(active, now) -
        (replaceExisting ? (existing?.amount ?? 0n) : 0n)
      if (active.highestVoucherAmount - active.spent - reservedAmount < amount)
        return active === current
          ? { op: 'noop', result: { channel: active, ok: false } }
          : { op: 'set', value: active, result: { channel: active, ok: false } }
      const channel = {
        ...active,
        streamReservations: {
          ...active.streamReservations,
          [reservationId]: {
            amount: replaceExisting ? amount : (existing?.amount ?? 0n) + amount,
            expiresAt: now + streamReservationTtlMs,
            units: replaceExisting ? 1 : (existing?.units ?? 0) + 1,
          },
        },
      }
      return { op: 'set', value: channel, result: { channel, ok: true } }
    })
    if (!result) throw new Error('channel not found')
    return result
  }

  let reserved = false
  const channel = await store.updateChannel(channelId, (current) => {
    reserved = false
    if (!current) return null
    const now = Date.now()
    const active = removeExpiredStreamReservations(current, now)
    if (active.finalized || active.closeRequestedAt !== 0n) return active
    const existing = active.streamReservations?.[reservationId]
    const reservedAmount =
      ChannelStore.reservedStreamAmount(active, now) -
      (replaceExisting ? (existing?.amount ?? 0n) : 0n)
    if (active.highestVoucherAmount - active.spent - reservedAmount < amount) return active
    reserved = true
    return {
      ...active,
      streamReservations: {
        ...active.streamReservations,
        [reservationId]: {
          amount: replaceExisting ? amount : (existing?.amount ?? 0n) + amount,
          expiresAt: now + streamReservationTtlMs,
          units: replaceExisting ? 1 : (existing?.units ?? 0) + 1,
        },
      },
    }
  })
  if (!channel) throw new Error('channel not found')
  return { channel, ok: reserved }
}

function removeExpiredStreamReservations(
  current: ChannelStore.State,
  now: number,
): ChannelStore.State {
  const reservations = current.streamReservations
  if (!reservations) return current
  const active = Object.fromEntries(
    Object.entries(reservations).filter(([, reservation]) => reservation.expiresAt > now),
  )
  if (
    Object.keys(active).length === Object.keys(reservations).length &&
    Object.entries(active).every(([id, reservation]) => reservation === reservations[id])
  )
    return current
  const { streamReservations: _, ...withoutReservations } = current
  return Object.keys(active).length > 0
    ? { ...withoutReservations, streamReservations: active }
    : withoutReservations
}

function removeStreamReservation(
  current: ChannelStore.State,
  reservationId: string,
): ChannelStore.State {
  const streamReservations = { ...current.streamReservations }
  delete streamReservations[reservationId]
  const { streamReservations: _, ...withoutReservations } = current
  return Object.keys(streamReservations).length > 0
    ? { ...withoutReservations, streamReservations }
    : withoutReservations
}

/** Throws when a channel can no longer be used for streaming charges. */
export function throwIfChannelClosed(channel: ChannelStore.State): void {
  if (channel.finalized) throw new ChannelClosedError({ reason: 'channel is finalized' })
  if (channel.closeRequestedAt !== 0n)
    throw new ChannelClosedError({ reason: 'channel has a pending close request' })
}

async function waitForUpdate(
  store: ChannelStore.ChannelStore,
  channelId: Hex,
  pollIntervalMs: number,
  signal?: AbortSignal,
): Promise<void> {
  throwIfAborted(signal)

  if (store.waitForUpdate) {
    const controller = new AbortController()
    const onAbort = () => controller.abort(signal?.reason)
    signal?.addEventListener('abort', onAbort, { once: true })
    try {
      await Promise.race([
        store.waitForUpdate(channelId, controller.signal),
        sleep(pollIntervalMs, controller.signal),
      ])
    } finally {
      signal?.removeEventListener('abort', onAbort)
      controller.abort()
    }
  } else {
    await sleep(pollIntervalMs, signal)
  }

  throwIfAborted(signal)
}

function sleep(ms: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timeout)
      reject(signal?.reason ?? new Error('aborted'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw signal.reason ?? new Error('aborted')
}

/** Minimal socket event map supported by browser and Node-style WebSocket runtimes. */
export type SocketEventMap = {
  close: Event | { code?: number | undefined; reason?: string | undefined; type?: string }
  error: Event | { type?: string }
  message: Event | { data: unknown; type?: string }
}

/** Socket event listener accepted by browser and Node-style runtimes. */
export type SocketEventListener<type extends keyof SocketEventMap> =
  | ((event: SocketEventMap[type]) => void)
  | { handleEvent(event: SocketEventMap[type]): void }

/** Minimal socket shape required by the session WebSocket adapter. */
export type Socket = {
  close(code?: number, reason?: string): unknown
  send(data: string): unknown
  addEventListener?: <type extends keyof SocketEventMap>(
    type: type,
    listener: SocketEventListener<type>,
  ) => unknown
  removeEventListener?: <type extends keyof SocketEventMap>(
    type: type,
    listener: SocketEventListener<type>,
  ) => unknown
  on?: <type extends keyof SocketEventMap>(
    type: type,
    listener: (event: SocketEventMap[type]) => void,
  ) => unknown
  off?: <type extends keyof SocketEventMap>(
    type: type,
    listener: (event: SocketEventMap[type]) => void,
  ) => unknown
}

/** Handlers for socket lifecycle and message events. */
export type SocketHandlers = {
  /** Called when the socket closes. */
  close(): void
  /** Called when the socket reports an error. */
  error(): void
  /** Called with raw message payloads. */
  message(payload: unknown): void
}

/** Subscribes to browser or Node-style socket events and returns an unsubscribe callback. */
export function subscribe(socket: Socket, handlers: SocketHandlers) {
  if (socket.addEventListener && socket.removeEventListener) {
    const onMessage = (event: SocketEventMap['message']) =>
      handlers.message('data' in event ? event.data : undefined)
    socket.addEventListener('message', onMessage)
    socket.addEventListener('close', handlers.close)
    socket.addEventListener('error', handlers.error)
    return () => {
      socket.removeEventListener?.('message', onMessage)
      socket.removeEventListener?.('close', handlers.close)
      socket.removeEventListener?.('error', handlers.error)
    }
  }

  if (socket.on && socket.off) {
    const onMessage = (data: unknown) => handlers.message(data)
    socket.on('message', onMessage)
    socket.on('close', handlers.close)
    socket.on('error', handlers.error)
    return () => {
      socket.off?.('message', onMessage)
      socket.off?.('close', handlers.close)
      socket.off?.('error', handlers.error)
    }
  }

  throw new Error('unsupported websocket implementation')
}

/** Sends a text frame through sync or async socket implementations. */
export async function send(socket: Socket, data: string) {
  await Promise.resolve(socket.send(data))
}

/** Converts socket message payloads into text frames when possible. */
export function toText(value: unknown): string | null {
  if (typeof value === 'string') return value
  if (value instanceof ArrayBuffer) return new TextDecoder().decode(value)
  if (ArrayBuffer.isView(value)) return new TextDecoder().decode(value)
  return null
}
