import { Json } from 'ox'
import type { Hex } from 'viem'

import * as Store from '../Store.js'
import { resolveSettleableVoucher, type State } from '../tempo/session/server/ChannelStore.js'

/** Storage key of a channel object's settlement bookkeeping, beside the channel state. */
const settlementKey = 'mppx:channel-store:settlement'

/**
 * Durable Object class that stores Tempo session channels, as {@link Store.durableObject}
 * does, and settles them on-chain without a request in flight.
 *
 * Every channel lives in its own object. After each write of a channel state, the object
 * checks how much a settlement could capture ({@link unsettledAmount}): from
 * `max(10% of deposit, minUnsettledAmount)` it sends `{ channelId }` to the settlement
 * queue at once; below that it sets an alarm that sends it once the channel has had no
 * write for `staleAfterMs`. The Worker's `queue()` handler settles it with
 * {@link settle}. After each send, a watchdog alarm sends it again while the channel
 * stays unsettled (a dropped, dead-lettered or failed job), waiting twice as long each
 * time, up to `maxAttempts` sends; settling more on-chain restarts the count. A close request,
 * or a threshold's worth of new vouchers since the last send, sends it again at once and
 * restarts the count, so a failed job never leaves them waiting on a long watchdog.
 *
 * Export a subclass from your Worker, bind it with a `new_sqlite_classes` migration and
 * bind the queue as `MPPX_SETTLEMENT_QUEUE`, or override
 * {@link ChannelStore.settlement} to change the queue or thresholds.
 *
 * @example
 * ```ts
 * import { DurableObject } from 'cloudflare:workers'
 * import { ChannelStore } from 'mppx/cloudflare'
 *
 * export class MppxChannels extends ChannelStore.rpc(DurableObject) {}
 * ```
 */
export class ChannelStore extends Store.DurableObjectStore {
  /**
   * The settlement queue and thresholds. Reads the `MPPX_SETTLEMENT_QUEUE` binding by
   * default; a subclass overrides it to use another binding or other thresholds.
   */
  protected settlement(): ChannelStore.Settlement {
    const env = this.env as { MPPX_SETTLEMENT_QUEUE?: ChannelStore.Queue | undefined } | undefined
    return { queue: env?.MPPX_SETTLEMENT_QUEUE }
  }

  /** Schedules settlement of a written channel state, and drops it for a closed or deleted one. */
  protected override async onWrite(
    key: string,
    _previous: unknown,
    next: unknown,
    transaction?: Store.DurableObjectStore.Storage | undefined,
  ): Promise<void> {
    // Writing through the store's transaction, when it has one, commits or rolls back with the write.
    const storage = transaction ?? this.storage
    const pending = (await storage.get(settlementKey)) as Pending | undefined
    const settlement = resolveSettlement(this.settlement())
    const due = isChannelState(next) ? settlementDue(next, settlement) : undefined
    if (!due || !isChannelState(next)) {
      if (pending?.key === key) await storage.delete(settlementKey)
      return
    }
    // A job settled more on-chain since it was sent: the job is done, so restart the count.
    const progressed =
      pending?.settledAtSend !== undefined && next.settledOnChain > pending.settledAtSend
    // Work the last send did not cover: a close request (once the escrow's grace period ends,
    // the payer can withdraw what is unsettled) or a threshold's worth of new vouchers. Send it
    // at once and restart the count instead of waiting for a watchdog that may be far off.
    const renewed =
      !!pending?.sends &&
      ((closing(next) && !pending.closingAtSend) ||
        (pending.capturedAtSend !== undefined &&
          settleableAmount(next) - pending.capturedAtSend >= threshold(next, settlement)))
    const sending = progressed || renewed ? undefined : pending?.sends ? pending : undefined
    const updated: Pending = {
      channelId: next.channelId,
      key,
      sends: sending?.sends ?? 0,
      updatedAt: Date.now(),
      ...(sending
        ? {
            capturedAtSend: sending.capturedAtSend,
            closingAtSend: sending.closingAtSend,
            settledAtSend: sending.settledAtSend,
          }
        : {}),
    }
    await storage.put(settlementKey, updated)
    // A job is in flight: it settles the latest voucher, and its watchdog alarm stays.
    if (sending) return
    // Sent from an alarm that fires at once: a queue send here would let another write in before this one commits.
    const at =
      due === 'threshold' || closing(next)
        ? Date.now()
        : updated.updatedAt + settlement.staleAfterMs
    const alarm = await storage.getAlarm!()
    if (alarm === null || at < alarm) await storage.setAlarm!(at)
  }

  /** Sends a channel over the threshold or gone stale to the queue, or sends it again from the watchdog while unsettled. */
  override async alarm(): Promise<void> {
    await super.alarm()
    const pending = (await this.storage.get(settlementKey)) as Pending | undefined
    if (!pending) return
    const raw = await this.storage.get(pending.key)
    // The store writes JSON text, or native values with `encoding: 'native'`.
    const state = typeof raw === 'string' ? Json.parse(raw) : (raw ?? null)
    const settlement = resolveSettlement(this.settlement())
    const due = isChannelState(state) ? settlementDue(state, settlement) : undefined
    if (!due) {
      await this.storage.delete(settlementKey)
      return
    }
    // The channel had a write since this alarm was set: wait until it has been idle long enough.
    const staleAt = pending.updatedAt + settlement.staleAfterMs
    if (!pending.sends && due === 'stale' && !closing(state as State) && Date.now() < staleAt)
      return this.storage.setAlarm!(staleAt)
    await this.send(pending, state as State, settlement, this.storage)
  }

  /**
   * Sends the channel to the settlement queue and sets the watchdog alarm, or gives up after
   * `maxAttempts` sends. A send that fails leaves the count alone and tries again from an
   * alarm, since the write that scheduled it has already committed.
   */
  private async send(
    pending: Pending,
    state: State,
    settlement: ResolvedSettlement,
    storage: Store.DurableObjectStore.Storage,
  ): Promise<void> {
    const sends = pending.sends + 1
    if (sends > settlement.maxAttempts) {
      await storage.delete(settlementKey)
      return
    }
    // A missing binding is a configuration error: fail the alarm so it shows in the Worker's
    // logs and Cloudflare retries it with backoff, rather than waking every minute in silence.
    if (!settlement.queue)
      throw new Error('ChannelStore: no settlement queue (bind MPPX_SETTLEMENT_QUEUE).')
    try {
      await settlement.queue.send({ channelId: pending.channelId } satisfies ChannelStore.Message)
    } catch {
      await storage.setAlarm!(Date.now() + settlement.retryMs)
      return
    }
    // The send awaited the queue, so a channel write may have changed the bookkeeping since
    // (such as restarting the count after progress): count this send against what is there now.
    const current = (await storage.get(settlementKey)) as Pending | undefined
    if (current?.key !== pending.key) return
    const counted = current.sends + 1
    await storage.put(settlementKey, {
      ...current,
      capturedAtSend: settleableAmount(state),
      closingAtSend: closing(state),
      sends: counted,
      settledAtSend: state.settledOnChain,
    } satisfies Pending)
    await storage.setAlarm!(Date.now() + settlement.watchdogMs * 2 ** (counted - 1))
  }
}

export declare namespace ChannelStore {
  /** The settlement queue and when to settle. */
  export type Settlement = {
    /** Queue the object sends `{ channelId }` to; the Worker's `queue()` handler settles it. */
    queue: Queue | undefined
    /** Raw amount a settlement must capture before it is sent at once, if 10% of the deposit is less. @default 100_000n */
    minUnsettledAmount?: bigint | undefined
    /** Sends a channel below the threshold once it has had no write for this long. @default 300_000 */
    staleAfterMs?: number | undefined
    /**
     * Sends a channel again this long after a send while it stays unsettled, doubling each time.
     * Keep the first resend well inside the escrow's close grace period (15 minutes), after which
     * a payer who requested a close can withdraw what is unsettled. @default 300_000
     */
    watchdogMs?: number | undefined
    /** Sends a channel at most this many times without on-chain progress. @default 6 */
    maxAttempts?: number | undefined
    /** Tries a send that failed again this much later. @default 60_000 */
    retryMs?: number | undefined
  }

  /** The subset of a Cloudflare `Queue` binding the object uses. */
  export type Queue = { send: (body: Message) => Promise<unknown> }

  /** The settlement job the object sends. */
  export type Message = { channelId: Hex }
}

/** A channel object's settlement bookkeeping. */
type Pending = {
  /** The channel's ID, sent to the queue. */
  channelId: Hex
  /** The store key the channel state lives under. */
  key: string
  /** Sends since the channel last settled more on-chain. */
  sends: number
  /** `settledOnChain` at the last send, to tell when that job made progress. */
  settledAtSend?: bigint | undefined
  /** The cumulative amount the last send could settle, to tell when a threshold's worth more arrived. */
  capturedAtSend?: bigint | undefined
  /** Whether the channel had a close request at the last send. */
  closingAtSend?: boolean | undefined
  /** Unix milliseconds of the channel's last write. */
  updatedAt: number
}

/** A {@link ChannelStore.Settlement} with its defaults filled in. */
type ResolvedSettlement = {
  [key in keyof ChannelStore.Settlement]-?: key extends 'queue'
    ? ChannelStore.Settlement[key]
    : NonNullable<ChannelStore.Settlement[key]>
}

/** Fills in the defaults of a {@link ChannelStore.Settlement}. */
function resolveSettlement(settlement: ChannelStore.Settlement): ResolvedSettlement {
  return {
    maxAttempts: settlement.maxAttempts ?? 6,
    minUnsettledAmount: settlement.minUnsettledAmount ?? 100_000n,
    queue: settlement.queue,
    retryMs: settlement.retryMs ?? 60_000,
    staleAfterMs: settlement.staleAfterMs ?? 300_000,
    watchdogMs: settlement.watchdogMs ?? 5 * 60_000,
  }
}

/** Whether a stored value is a precompile-backed session channel state. */
export function isChannelState(value: unknown): value is State {
  if (typeof value !== 'object' || value === null) return false
  const state = value as Record<string, unknown>
  return (
    state.backend === 'precompile' &&
    typeof state.channelId === 'string' &&
    typeof state.chainId === 'number' &&
    typeof state.deposit === 'bigint' &&
    typeof state.settledOnChain === 'bigint' &&
    typeof state.spent === 'bigint'
  )
}

/**
 * The raw amount a settlement of the channel would capture now: the largest accepted voucher
 * within `spent` (as mppx's `settle` picks it) above `settledOnChain`.
 */
export function unsettledAmount(state: State): bigint {
  return settleableAmount(state) - state.settledOnChain
}

/** The cumulative amount a settlement of the channel would bring it to: its settleable voucher's, or `settledOnChain`. */
function settleableAmount(state: State): bigint {
  return resolveSettleableVoucher(state)?.cumulativeAmount ?? state.settledOnChain
}

/** Whether the payer requested a close, after which the escrow's grace period runs. */
function closing(state: State): boolean {
  return !!state.closeRequestedAt
}

/** The unsettled amount that sends a channel at once: `max(10% of deposit, minUnsettledAmount)`. */
function threshold(
  state: State,
  settlement: Pick<ChannelStore.Settlement, 'minUnsettledAmount'>,
): bigint {
  const minimum = settlement.minUnsettledAmount ?? 100_000n
  const tenth = state.deposit / 10n
  return tenth > minimum ? tenth : minimum
}

/**
 * When the channel needs settling: `threshold` (now) once the unsettled amount reaches
 * `max(10% of deposit, minUnsettledAmount)`, `stale` (once idle) below it, or
 * `undefined` when it is finalized or has nothing to settle.
 */
export function settlementDue(
  state: State,
  settlement: Pick<ChannelStore.Settlement, 'minUnsettledAmount'> = {},
): 'stale' | 'threshold' | undefined {
  if (state.finalized) return undefined
  const unsettled = unsettledAmount(state)
  if (unsettled <= 0n) return undefined
  return unsettled >= threshold(state, settlement) ? 'threshold' : 'stale'
}
