import type { Hex } from 'viem'

import type { MaybePromise } from '../../../internal/types.js'
import type { NeedVoucherEvent } from '../precompile/Protocol.js'
import * as ChannelStore from './ChannelStore.js'
import {
  commitReservedCharges,
  finalizeCommittedCharges,
  maintainReservedCharges,
  releaseReservedCharges,
  reserveChargeOrWait,
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
  /** Existing shared reservation to commit on the next emitted value. */
  reservationId?: string | undefined
  /** Implicit units already covered by the existing reservation. */
  reservedUnits?: number | undefined
  /** Optional abort signal for stream cancellation. */
  signal?: AbortSignal | undefined
  /** Channel store used for state reads and atomic charge commits. */
  store: ChannelStore.ChannelStore
  /** Raw token cost per emitted value. */
  tickCost: bigint
}

/** Value whose committed reservation is finalized after transport delivery. */
export type MeteredValue = {
  delivered(): Promise<void>
  value: string
}

/** Applies voucher reservation and spend commits to an async session stream. */
export async function* meterIterable(options: MeteredStreamOptions): AsyncGenerator<MeteredValue> {
  let prepaidUnits = options.prepaidUnits ?? 0
  let reservedUnits = options.reservedUnits ?? 0
  let reservationPending = reservedUnits > 0
  const reservationId = options.reservationId ?? globalThis.crypto.randomUUID()
  let stopMaintainingReservation: (() => void) | undefined
  let releasePromise: Promise<void> | undefined

  const maintainReservation = () => {
    if (stopMaintainingReservation) return
    stopMaintainingReservation = maintainReservedCharges({
      store: options.store,
      channelId: options.channelId,
      reservationId,
    })
  }
  const stopMaintaining = () => {
    stopMaintainingReservation?.()
    stopMaintainingReservation = undefined
  }
  const releaseReservation = () => {
    stopMaintaining()
    if (!reservationPending) return Promise.resolve()
    releasePromise ??= releaseReservedCharges({
      store: options.store,
      channelId: options.channelId,
      reservationId,
    })
      .then(() => {
        reservationPending = false
      })
      .finally(() => {
        releasePromise = undefined
      })
    return releasePromise
  }
  if (reservationPending) maintainReservation()

  const onAbort = () => {
    void releaseReservation().catch(() => undefined)
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  if (options.signal?.aborted) onAbort()

  const charge = async (amount?: bigint) => {
    if (amount === undefined && prepaidUnits > 0) {
      prepaidUnits -= 1
      return
    }
    if (amount === undefined && reservedUnits > 0) {
      reservedUnits -= 1
      return
    }

    const resolvedAmount = amount ?? options.tickCost
    const replaceExisting = amount !== undefined && reservedUnits > 0

    await reserveChargeOrWait({
      store: options.store,
      channelId: options.channelId,
      amount: resolvedAmount,
      reservationId,
      emit: options.emitNeedVoucher,
      formatNeedVoucher: options.formatNeedVoucher,
      pollIntervalMs: options.pollIntervalMs,
      replaceExisting,
      signal: options.signal,
    })
    if (replaceExisting) reservedUnits = 0
    reservationPending = true
    if (options.signal?.aborted) {
      await releaseReservation()
      return
    }
    maintainReservation()
  }

  /** Keeps completed work charged even when reservation cleanup fails. */
  const finalize = async () => {
    // Delivery or successful generator completion is irreversible. Prevent cleanup from rolling the
    // charge back even if removing its persisted marker transiently fails.
    reservationPending = false
    stopMaintaining()
    let channel: ChannelStore.State
    try {
      channel = await finalizeCommittedCharges({
        store: options.store,
        channelId: options.channelId,
        reservationId,
      })
    } catch (error) {
      // Retry once for stores that persisted an update but failed while
      // acknowledging it. The committed marker also has a bounded lease,
      // so a terminated worker cannot block channel close indefinitely.
      try {
        await finalizeCommittedCharges({
          store: options.store,
          channelId: options.channelId,
          reservationId,
        })
      } catch {
        // Preserve the original cleanup failure.
      }
      throw error
    }
    await options.onChargeCommitted?.(channel)
  }

  const signal = options.signal ?? new AbortController().signal

  try {
    const iterable =
      typeof options.generate === 'function'
        ? options.generate({ charge, signal })
        : options.generate
    for await (const value of iterable) {
      if (options.signal?.aborted) break
      if (typeof options.generate !== 'function') await charge()
      if (options.signal?.aborted) {
        await releaseReservation()
        break
      }
      let chargeCommitted = false
      if (reservationPending) {
        await commitReservedCharges({
          store: options.store,
          channelId: options.channelId,
          reservationId,
          signal: options.signal,
        })
        chargeCommitted = true
        reservedUnits = 0
      }
      if (options.signal?.aborted) {
        await releaseReservation()
        break
      }
      yield {
        value,
        async delivered() {
          if (!chargeCommitted) return
          chargeCommitted = false
          await finalize()
        },
      }
    }
    if (!options.signal?.aborted && reservationPending && reservedUnits === 0) {
      await commitReservedCharges({
        store: options.store,
        channelId: options.channelId,
        reservationId,
        signal: options.signal,
      })
      if (!options.signal?.aborted) await finalize()
    }
  } finally {
    options.signal?.removeEventListener('abort', onAbort)
    await releaseReservation()
  }
}
