import type { Hex } from 'viem'

import type { NeedVoucherEvent } from '../precompile/Protocol.js'
import * as ChannelStore from './ChannelStore.js'
import { commitReservedCharges, reserveChargeOrWait } from './Transports.js'

/** Controller passed to manual-charge streaming generators. */
export type SessionController = {
  /**
   * Reserve voucher coverage for the next emitted chunk.
   *
   * The reservation blocks until sufficient voucher headroom exists, but the
   * charge is only committed once a chunk is actually emitted. If the stream
   * ends or aborts before that emission, the reservation is dropped.
   */
  charge(): Promise<void>
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
  /** Store polling interval when `waitForUpdate` is unavailable. */
  pollIntervalMs: number
  /** Pre-authorized units that may be emitted without reserving new voucher headroom. */
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
  let reservedAmount = 0n
  let reservedUnits = 0

  const charge = async () => {
    if (prepaidUnits > 0) {
      prepaidUnits -= 1
      return
    }

    await reserveChargeOrWait({
      store: options.store,
      channelId: options.channelId,
      amount: options.tickCost,
      reservedAmount,
      emit: options.emitNeedVoucher,
      formatNeedVoucher: options.formatNeedVoucher,
      pollIntervalMs: options.pollIntervalMs,
      signal: options.signal,
    })
    reservedAmount += options.tickCost
    reservedUnits += 1
  }

  const iterable =
    typeof options.generate === 'function' ? options.generate({ charge }) : options.generate

  for await (const value of iterable) {
    if (options.signal?.aborted) break
    if (typeof options.generate !== 'function') await charge()
    await commitReservedCharges({
      store: options.store,
      channelId: options.channelId,
      amount: reservedAmount,
      units: reservedUnits,
    })
    reservedAmount = 0n
    reservedUnits = 0
    yield value
  }
}
