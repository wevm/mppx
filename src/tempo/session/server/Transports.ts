import type { Hex } from 'viem'

import { ChannelClosedError } from '../../../Errors.js'
import type { NeedVoucherEvent } from '../precompile/Protocol.js'
import * as ChannelStore from './ChannelStore.js'

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
  /** Amount already reserved but not yet committed by this stream loop. */
  reservedAmount: bigint
  /** Optional abort signal for long waits. */
  signal?: AbortSignal | undefined
  /** Channel store used for state reads and waits. */
  store: ChannelStore.ChannelStore
}

/** Parameters for committing previously reserved stream charges. */
export type CommitReservedChargesParameters = {
  /** Reserved amount to commit. */
  amount: bigint
  /** Channel being metered. */
  channelId: Hex
  /** Channel store used for atomic updates. */
  store: ChannelStore.ChannelStore
  /** Number of charge units to add. */
  units: number
}

/**
 * Reserves voucher headroom for a future stream emission.
 *
 * If the channel lacks headroom, emits one need-voucher frame, then waits for
 * a store update or polling interval until the accepted voucher covers both
 * already-reserved charges and the next requested amount.
 */
export async function reserveChargeOrWait(options: ReserveChargeParameters): Promise<void> {
  const {
    amount,
    channelId,
    emit,
    formatNeedVoucher,
    pollIntervalMs,
    reservedAmount,
    signal,
    store,
  } = options

  let channel = await store.getChannel(channelId)
  if (!channel) throw new Error('channel not found')
  throwIfChannelClosed(channel)

  const hasHeadroom = (state: ChannelStore.State) =>
    state.highestVoucherAmount - state.spent - reservedAmount >= amount

  if (hasHeadroom(channel)) return

  await Promise.resolve(
    emit(
      formatNeedVoucher({
        channelId,
        requiredCumulative: (channel.spent + reservedAmount + amount).toString(),
        acceptedCumulative: channel.highestVoucherAmount.toString(),
        deposit: channel.deposit.toString(),
      }),
    ),
  )

  while (!hasHeadroom(channel)) {
    await waitForUpdate(store, channelId, pollIntervalMs, signal)
    channel = await store.getChannel(channelId)
    if (!channel) throw new Error('channel not found')
    throwIfChannelClosed(channel)
  }
}

/** Atomically commits previously reserved stream charges to channel spend and unit counters. */
export async function commitReservedCharges(
  options: CommitReservedChargesParameters,
): Promise<void> {
  const { amount, channelId, store, units } = options
  if (amount === 0n || units === 0) return

  let committed = false
  const channel = await store.updateChannel(channelId, (current) => {
    if (!current) return null
    if (current.finalized) return current
    if (current.closeRequestedAt !== 0n) return current
    if (current.highestVoucherAmount - current.spent < amount) return current
    committed = true
    return {
      ...current,
      spent: current.spent + amount,
      units: current.units + units,
    }
  })

  if (!channel) throw new Error('channel not found')
  throwIfChannelClosed(channel)
  if (!committed) throw new Error('reserved voucher coverage is no longer available')
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
    await Promise.race([
      store.waitForUpdate(channelId),
      sleep(pollIntervalMs, signal),
      ...(signal ? [onceAborted(signal)] : []),
    ])
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

function onceAborted(signal: AbortSignal) {
  return new Promise<never>((_, reject) => {
    if (signal.aborted) {
      reject(signal.reason ?? new Error('aborted'))
      return
    }
    signal.addEventListener('abort', () => reject(signal.reason ?? new Error('aborted')), {
      once: true,
    })
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
