import type { Hex } from 'viem'

import type { MaybePromise } from '../../../internal/types.js'
import type { NeedVoucherEvent } from '../precompile/Protocol.js'
import * as ChannelStore from './ChannelStore.js'
import {
  commitReservedCharges,
  releaseReservedCharges,
  renewReservedCharges,
  reserveChargeOrWait,
  streamReservationLeaseMs,
} from './Transports.js'

/** Controller passed to manual-charge streaming generators. */
export type SessionController = {
  /**
   * Reserve voucher coverage for the next emitted chunk.
   *
   * The reservation blocks until sufficient voucher headroom exists, but the
   * charge is committed when a chunk is emitted or when the generator finishes
   * successfully. A reservation is only dropped when the stream aborts or the
   * generator fails before the charge can be committed.
   *
   * Pass an explicit raw-unit `amount` for request-aware or otherwise dynamic
   * pricing. When omitted, the session challenge's configured tick cost is
   * used.
   */
  charge(amount?: bigint): Promise<void>
  /** Aborted when the client closes or requests the final session receipt. */
  signal: AbortSignal
}

/** Async stream source accepted by paid session transports. */
export type SessionStreamGenerator =
  | AsyncIterable<string>
  | ((stream: SessionController) => AsyncIterable<string>)

/** Options for metering a paid stream before transport-specific formatting. */
export type MeteredStreamOptions = {
  /** Channel being metered. */
  channelId: Hex
  /** Emits a transport-specific need-voucher frame. */
  emitNeedVoucher(message: string): void | Promise<void>
  /** Formats a transport-specific need-voucher frame. */
  formatNeedVoucher(parameters: NeedVoucherEvent): string
  /** Async source or manual-charge source. */
  generate: SessionStreamGenerator
  /** Runs after a nonzero reserved charge has been committed. */
  onChargeCommitted?: ((channel: ChannelStore.State) => MaybePromise<unknown>) | undefined
  /** Store polling interval when `waitForUpdate` is unavailable. */
  pollIntervalMs: number
  /** Pre-authorized implicit tick-cost units that may be emitted without a new reservation. */
  prepaidUnits?: number | undefined
  /** Optional abort signal for stream cancellation. */
  signal?: AbortSignal | undefined
  /** Channel store used for state reads and atomic charge commits. */
  store: ChannelStore.ChannelStore
  /** Raw token cost per emitted value. */
  tickCost: bigint
}

/** Applies voucher reservation and spend commits to an async session stream. */
export async function* meterIterable(options: MeteredStreamOptions): AsyncGenerator<string> {
  let prepaidUnits = options.prepaidUnits ?? 0
  const controller = new AbortController()
  const signal = controller.signal
  const reservation = {
    store: options.store,
    channelId: options.channelId,
    reservationId: globalThis.crypto.randomUUID(),
  }
  let pending = false
  let cancelled = false
  const onAbort = () => {
    if (signal.aborted) return
    cancelled = true
    controller.abort(options.signal?.reason)
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()
  const renewal = setInterval(() => {
    if (pending) void renewReservedCharges(reservation).catch((error) => controller.abort(error))
  }, streamReservationLeaseMs / 3)
  ;(renewal as unknown as { unref?: () => void }).unref?.()
  const releaseOnAbort = () => {
    clearInterval(renewal)
    void releaseReservedCharges(reservation).catch(() => {})
  }
  signal.addEventListener('abort', releaseOnAbort, { once: true })
  if (signal.aborted) releaseOnAbort()
  const charge = async (amount?: bigint) => {
    signal.throwIfAborted()
    if (amount === undefined && prepaidUnits > 0) {
      prepaidUnits -= 1
      return
    }
    if ((amount ?? options.tickCost) === 0n) return
    await reserveChargeOrWait({
      ...reservation,
      requireExisting: pending,
      amount: amount ?? options.tickCost,
      emit: options.emitNeedVoucher,
      formatNeedVoucher: options.formatNeedVoucher,
      pollIntervalMs: options.pollIntervalMs,
      signal,
    })
    pending = true
    signal.throwIfAborted()
  }
  const commit = async () => {
    signal.throwIfAborted()
    if (!pending) return
    const channel = await commitReservedCharges(reservation)
    if (!channel) throw new Error('stream reservation was lost')
    pending = false
    await options.onChargeCommitted?.(channel)
  }
  try {
    const manual = typeof options.generate === 'function'
    const iterable =
      typeof options.generate === 'function'
        ? options.generate({ charge, signal })
        : options.generate
    const iterator = iterable[Symbol.asyncIterator]()
    try {
      while (!signal.aborted) {
        const { done, value } = await iterator.next()
        if (signal.aborted) break
        if (done) {
          if (manual) await commit()
          break
        }
        if (!manual) await charge()
        await commit()
        yield value
      }
      if (!cancelled) signal.throwIfAborted()
    } finally {
      clearInterval(renewal)
      await releaseReservedCharges(reservation)
      await iterator.return?.()
    }
  } finally {
    clearInterval(renewal)
    options.signal?.removeEventListener('abort', onAbort)
    signal.removeEventListener('abort', releaseOnAbort)
    await releaseReservedCharges(reservation)
  }
}
