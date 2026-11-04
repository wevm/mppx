import type { Hex } from 'viem'

import * as Constants from '../../../Constants.js'
import * as Credential from '../../../Credential.js'
import {
  createSessionReceipt,
  extractData,
  formatMessageEvent,
  formatNeedVoucherEvent,
  formatReceiptEvent,
  readSessionChallengeAmount,
  requireSessionCredentialContext,
} from '../precompile/Protocol.js'
import * as ChannelStore from './ChannelStore.js'
import {
  meterIterable,
  type MeteredStreamOptions,
  type SessionController,
} from './MeteredStream.js'

/** A failed prepaid delivery that needs merchant reconciliation. */
export type PrepaidRefund = {
  /** Channel that paid for the undelivered items. */
  channelId: Hex
  /** Undelivered prepaid amount in raw token units; use externalRefundAmount for transfers. */
  amount: bigint
  /** Captured share safe to refund externally, or null until reconciliation establishes it. */
  externalRefundAmount: bigint | null
  /** Charge units included in the credit attempt. */
  units: number
  /** Use this key for both credit retries and an idempotent merchant refund. */
  idempotencyKey: string
  /** An unknown credit must be reconciled with the same key before refunding externally. */
  credit:
    | { status: 'failed'; error: unknown }
    | Exclude<ChannelStore.CreditResult, { status: 'credited' }>
}

/** Exposes durable retry information when no refund hook is configured or it fails. */
export class PrepaidRefundError extends Error {
  override readonly name = 'PrepaidRefundError'
  constructor(readonly refund: PrepaidRefund) {
    super('Prepaid stream delivery failed and requires merchant refund reconciliation.')
  }
}

/** Maximum retained automatic refund operations per channel. Never evict live retry keys. */
export const maxPrepaidRefunds = 128

/**
 * Persist a delivery obligation before returning a managed response. Failed hook deliveries remain
 * in `channel.prepaidRefunds` for a merchant worker. Pending entries require manual delivery
 * reconciliation; failed entries may retry the credit with their original terms within 24 hours.
 * Acknowledging the hook means the merchant has durably accepted responsibility for the job.
 */
export async function preparePrepaidRefund(options: serve.Options): Promise<void> {
  if (!options.autoCreditPrepaid || !options.prepaidUnits || options.tickCost === 0n) return
  if (!options.refundIdempotencyKey)
    throw new Error('Automatic refunds require a stable refundIdempotencyKey')
  const key = options.refundIdempotencyKey
  const amount = (BigInt(options.prepaidUnits) * options.tickCost).toString()
  await options.store.updateChannel(options.channelId, (current) => {
    if (!current) throw new Error('Cannot prepare prepaid refund: channel not found')
    const existing = current.prepaidRefunds?.[key]
    if (existing) {
      if (existing.amount !== amount || existing.units !== options.prepaidUnits)
        throw new Error('Prepaid refund key conflicts with an existing delivery')
      return current
    }
    const liveMarkers = Object.values(current.idempotencyMarkers ?? {}).filter(
      (marker) => marker.expiresAt > Date.now(),
    ).length
    if (Object.keys(current.prepaidRefunds ?? {}).length + liveMarkers >= maxPrepaidRefunds)
      throw new Error('Prepaid refund capacity reached; reconcile outstanding deliveries')
    return {
      ...current,
      prepaidRefunds: {
        ...current.prepaidRefunds,
        [key]: {
          amount,
          units: options.prepaidUnits!,
          status: 'pending' as const,
          createdAt: Date.now(),
        },
      },
    }
  })
}

/**
 * SSE (Server-Sent Events) utilities for metered streaming payments.
 *
 * Provides event formatting/parsing, balance polling, the core
 * `serve()` loop that meters an async iterable into a ReadableStream
 * of SSE events, and helpers (`toResponse`, `fromRequest`) for
 * building HTTP responses from the stream.
 */

export {
  extractData,
  formatMessageEvent,
  formatNeedVoucherEvent,
  formatReceiptEvent,
  parseEvent,
  readSessionChallengeAmount,
  requireSessionCredentialContext,
  type SseEvent,
} from '../precompile/Protocol.js'

/** Controller passed to manual-charge SSE generators. */
export type { SessionController } from './MeteredStream.js'

/**
 * Wrap an async iterable with payment metering, producing an SSE stream.
 *
 * `generate` may be either:
 * - An `AsyncIterable<string>` — each yielded value is automatically charged
 *   (one `tickCost` per value).
 * - A callback `(stream: SessionController) => AsyncIterable<string>` — the
 *   generator controls when charges happen by calling `stream.charge()`.
 *
 * For each emitted value the stream:
 * 1. Reserves `tickCost` from the channel's available voucher headroom
 *    (auto or manual).
 * 2. If balance is sufficient, emits `event: message` with the value.
 * 3. If balance is exhausted, emits `event: payment-need-voucher`
 *    and polls store until the client tops up the channel.
 * 4. Commits automatic charges before emission and manual charges before
 *    `stream.charge()` resolves, retaining them on cancellation or failure.
 * 5. On generator completion, emits a final `event: payment-receipt`.
 *
 * With `autoCreditPrepaid`, a failure before a prepaid item is enqueued attempts an idempotent credit.
 * If credit is declined or uncertain, `onRefundRequired` handles merchant reconciliation.
 *
 * Returns a `ReadableStream<Uint8Array>` suitable for use as an HTTP response body.
 */
export function serve(options: serve.Options): ReadableStream<Uint8Array> {
  const {
    store,
    channelId,
    challengeId,
    tickCost,
    generate,
    pollIntervalMs = 100,
    signal,
  } = options

  const encoder = new TextEncoder()
  const abortController = new AbortController()
  let streamController: ReadableStreamDefaultController<Uint8Array> | undefined
  let terminal = false
  let committedPrepaidAwaitingDelivery = 0
  let undeliveredPrepaidUnits = options.prepaidUnits ?? 0
  if (!Number.isSafeInteger(undeliveredPrepaidUnits) || undeliveredPrepaidUnits < 0)
    throw new Error('prepaidUnits must be a non-negative safe integer')
  const refundIdempotencyKey =
    options.refundIdempotencyKey ?? `stream:${globalThis.crypto.randomUUID()}`
  ChannelStore.assertIdempotencyOptions({ idempotencyKey: refundIdempotencyKey })
  const refundOptions = { ...options, refundIdempotencyKey }
  const clearObligation = async () => {
    if (!options.autoCreditPrepaid) return
    await store.updateChannel(channelId, (current) => {
      if (!current?.prepaidRefunds?.[refundIdempotencyKey]) return current
      const prepaidRefunds = { ...current.prepaidRefunds }
      delete prepaidRefunds[refundIdempotencyKey]
      return { ...current, prepaidRefunds }
    })
  }
  const creditFailedDelivery = async () => {
    if (!options.autoCreditPrepaid) return
    if (undeliveredPrepaidUnits === 0 || tickCost === 0n) {
      await clearObligation()
      return
    }
    const recordFailure = await store
      .updateChannel(channelId, (current) => {
        if (!current?.prepaidRefunds?.[refundIdempotencyKey])
          throw new Error('Prepaid refund obligation missing')
        return {
          ...current,
          prepaidRefunds: {
            ...current.prepaidRefunds,
            [refundIdempotencyKey]: {
              ...current.prepaidRefunds[refundIdempotencyKey]!,
              status: 'failed',
              amount: (BigInt(undeliveredPrepaidUnits) * tickCost).toString(),
              units: undeliveredPrepaidUnits,
            },
          },
        }
      })
      .then(
        () => undefined,
        (error: unknown) => ({ error }),
      )
    const amount = BigInt(undeliveredPrepaidUnits) * tickCost
    const result = recordFailure
      ? { status: 'failed' as const, error: recordFailure.error }
      : await ChannelStore.creditChannel(store, channelId, amount, {
          idempotencyKey: refundIdempotencyKey,
          units: undeliveredPrepaidUnits,
          maxMarkers: maxPrepaidRefunds,
        }).catch((error: unknown) => ({ status: 'failed' as const, error }))
    if (result.status === 'credited') {
      await clearObligation()
      return
    }
    let externalRefundAmount: bigint | null = null
    if (result.status === 'declined' && result.reason === 'finalized') {
      const captured = result.channel.settledOnChain - (result.channel.spent - amount)
      externalRefundAmount = captured < 0n ? 0n : captured > amount ? amount : captured
      if (externalRefundAmount === 0n) {
        await clearObligation()
        return
      }
    }
    const refund: PrepaidRefund = {
      channelId,
      amount,
      externalRefundAmount,
      units: undeliveredPrepaidUnits,
      idempotencyKey: refundIdempotencyKey,
      credit: result,
    }
    if (!options.onRefundRequired) throw new PrepaidRefundError(refund)
    try {
      await options.onRefundRequired(refund)
      await clearObligation()
    } catch {
      throw new PrepaidRefundError(refund)
    }
  }
  const iterator = meterIterable({
    store,
    channelId,
    tickCost,
    generate,
    chargeOnce: options.chargeOnce,
    onPrepaidChargeCommitted() {
      undeliveredPrepaidUnits = Math.max(0, undeliveredPrepaidUnits - 1)
      committedPrepaidAwaitingDelivery += 1
    },
    beforeCharge: options.beforeCharge,
    onChargeCommitted: options.onChargeCommitted,
    pollIntervalMs,
    prepaidUnits: options.prepaidUnits,
    signal: abortController.signal,
    emitNeedVoucher: (event) => streamController?.enqueue(encoder.encode(event)),
    formatNeedVoucher: formatNeedVoucherEvent,
  })[Symbol.asyncIterator]()

  const cleanup = () => signal?.removeEventListener('abort', abort)
  const terminate = (reason?: unknown) => {
    if (terminal) return
    terminal = true
    abortController.abort(reason)
    cleanup()
    void Promise.resolve()
      .then(() => iterator.return?.(undefined))
      .catch(() => {})
    try {
      streamController?.close()
    } catch {}
  }
  const abort = () => terminate(signal?.reason)
  signal?.addEventListener('abort', abort, { once: true })

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      streamController = controller
      await preparePrepaidRefund(refundOptions)
      if (signal?.aborted) abort()
    },
    async pull(controller) {
      if (terminal) return
      try {
        const next = await iterator.next()
        if (terminal) return
        if (!next.done) {
          if (abortController.signal.aborted) return
          const value = next.value
          controller.enqueue(encoder.encode(formatMessageEvent(value)))
          if (committedPrepaidAwaitingDelivery > 0) committedPrepaidAwaitingDelivery -= 1
          else undeliveredPrepaidUnits = Math.max(0, undeliveredPrepaidUnits - 1)
          return
        }

        await clearObligation()
        if (!abortController.signal.aborted) {
          const channel = await store.getChannel(channelId)
          if (channel) {
            const receipt = createSessionReceipt({
              challengeId,
              channelId,
              acceptedCumulative: channel.highestVoucherAmount,
              spent: channel.spent,
              units: channel.units,
            })
            controller.enqueue(encoder.encode(formatReceiptEvent(receipt)))
            terminal = true
            cleanup()
            controller.close()
            return
          }
        }
        terminal = true
        cleanup()
        controller.close()
      } catch (e) {
        if (terminal) return
        terminal = true
        cleanup()
        if (!abortController.signal.aborted) {
          try {
            await creditFailedDelivery()
            controller.error(e)
          } catch (refundError) {
            controller.error(
              new AggregateError([e, refundError], 'Stream delivery and prepaid refund failed.'),
            )
          }
        } else controller.close()
      }
    },
    cancel(reason) {
      terminate(reason)
    },
  })
}

/** Type helpers for {@link serve}. */
export declare namespace serve {
  type Options = {
    store: ChannelStore.ChannelStore
    channelId: Hex
    challengeId: string
    tickCost: bigint
    generate: AsyncIterable<string> | ((stream: SessionController) => AsyncIterable<string>)
    /** Charge automatic iterables once per request; explicit manual charges are unaffected. */
    chargeOnce?: boolean | undefined
    /** Verifies live escrow before charging and delivering stream items. */
    beforeCharge?: MeteredStreamOptions['beforeCharge']
    /** Callback invoked after each nonzero stream charge is committed. */
    onChargeCommitted?: MeteredStreamOptions['onChargeCommitted']
    pollIntervalMs?: number | undefined
    /** Opt in to SDK-owned credits. Leave disabled when the merchant already refunds failed requests. @default false */
    autoCreditPrepaid?: boolean | undefined
    /** Units charged before streaming. */
    prepaidUnits?: number | undefined
    /** Stable per-charge key used for automatic credit and merchant refund retries. Defaults to a random stream key. */
    refundIdempotencyKey?: string | undefined
    /**
     * Persist or perform an idempotent refund when a failed prepaid delivery cannot be credited.
     * For `credit.status === 'unknown'`, retry `Session.Server.credit` with the supplied key,
     * amount and units before refunding externally; the credit may already have committed.
     * Retry within the credit marker retention (24 hours); later retries need manual reconciliation.
     * Only transfer `externalRefundAmount` when non-null; closing, pending settlement and definite
     * failures require reconciliation first. `failed` is a definite non-credit, not an uncertain write.
     * Successful return must mean durable acceptance. Missing/throwing hooks leave obligations in
     * `channel.prepaidRefunds`; run a recovery worker and reconcile pending delivery records manually.
     * Records are bounded and never evicted while unresolved. A full ledger rejects new streams.
     * Hook failures surface a `PrepaidRefundError` containing the retry information.
     * Delivered items, explicit manual charges and client cancellation are not automatically refunded.
     */
    onRefundRequired?: ((refund: PrepaidRefund) => void | Promise<void>) | undefined
    signal?: AbortSignal | undefined
  }
}

/**
 * Wrap a `ReadableStream<Uint8Array>` (from {@link serve}) in an HTTP
 * `Response` with the correct SSE headers.
 */
export function toResponse(body: ReadableStream<Uint8Array>): Response {
  return new Response(body, {
    headers: {
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'Content-Type': 'text/event-stream; charset=utf-8',
    },
  })
}

/**
 * Extract `channelId`, `challengeId`, and `tickCost` from a `Request`'s
 * `Authorization: Payment …` header.
 *
 * This is a convenience for callers that receive a raw `Request` and need
 * the parameters required by {@link serve}.
 */
export function fromRequest(request: Request): fromRequest.Context {
  const header = request.headers.get(Constants.Headers.authorization)
  if (!header) throw new Error('Missing Authorization header.')

  const payment = Credential.extractPaymentScheme(header)
  if (!payment) throw new Error('Missing Payment credential in Authorization header.')

  const credential = Credential.deserialize(payment)
  const payload = requireSessionCredentialContext(credential.payload)
  return {
    challengeId: credential.challenge.id,
    channelId: payload.channelId,
    tickCost: readSessionChallengeAmount(credential.challenge),
  }
}

/** Type helpers for {@link fromRequest}. */
export declare namespace fromRequest {
  type Context = {
    challengeId: string
    channelId: Hex
    tickCost: bigint
  }
}

/**
 * Check whether a `Response` carries an SSE event stream.
 *
 * Returns `true` when the `Content-Type` header starts with
 * `text/event-stream` (case-insensitive, ignoring charset params).
 */
export function isEventStream(response: Response): boolean {
  const ct = response.headers.get('content-type')
  return ct?.toLowerCase().startsWith('text/event-stream') ?? false
}

/**
 * Parse an SSE `Response` body into an async iterable of `data:` payloads.
 *
 * Yields the raw `data:` field content for each SSE event in the stream.
 * Events whose data matches the `skip` predicate are silently dropped
 * (e.g. `[DONE]` sentinels used by OpenAI-compatible APIs).
 *
 * Each yielded value typically becomes one charge tick when fed to
 * {@link serve} via the SSE transport's auto-charge mode.
 *
 * @example
 * ```ts
 * const upstream = await fetch('https://api.example.com/stream')
 * for await (const data of Sse.iterateData(upstream)) {
 *   console.log(data)
 * }
 * ```
 */
export async function* iterateData(
  response: Response,
  options?: iterateData.Options,
): AsyncGenerator<string> {
  const skip = options?.skip
  const body = response.body
  if (!body) return

  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) buffer += decoder.decode()
      else buffer += decoder.decode(value, { stream: true })

      while (true) {
        const separator = findSseSeparator(buffer, done)
        if (!separator) break
        const event = buffer.slice(0, separator.index)
        buffer = buffer.slice(separator.index + separator.length)
        if (!event.trim()) continue
        const data = extractData(event.replace(/\r\n|\r/g, '\n'))
        if (data === null) continue
        if (skip?.(data)) continue
        yield data
      }
      if (done) break
    }

    // Flush remaining buffer.
    if (buffer.trim()) {
      const data = extractData(buffer.replace(/\r\n|\r/g, '\n'))
      if (data !== null && !skip?.(data)) yield data
    }
  } finally {
    reader.releaseLock()
  }
}

function findSseSeparator(
  value: string,
  complete: boolean,
): { index: number; length: number } | undefined {
  for (let index = 0; index < value.length; index++) {
    const first = lineEndingLength(value, index, complete)
    if (!first) continue
    const second = lineEndingLength(value, index + first, complete)
    if (second) return { index, length: first + second }
    index += first - 1
  }
  return undefined
}

function lineEndingLength(value: string, index: number, complete: boolean): number {
  if (value[index] === '\n') return 1
  if (value[index] !== '\r') return 0
  if (value[index + 1] === '\n') return 2
  if (index + 1 === value.length && !complete) return 0
  return 1
}

/** Type helpers for {@link iterateData}. */
export declare namespace iterateData {
  type Options = {
    /** Predicate to skip specific data payloads (e.g. `d => d === '[DONE]'`). */
    skip?: ((data: string) => boolean) | undefined
  }
}
