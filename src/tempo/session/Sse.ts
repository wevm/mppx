/**
 * SSE (Server-Sent Events) utilities for metered streaming payments.
 *
 * Provides event formatting/parsing, balance polling, the core
 * `serve()` loop that meters an async iterable into a ReadableStream
 * of SSE events, and helpers (`toResponse`, `fromRequest`) for
 * building HTTP responses from the stream.
 */
import type { Hex } from 'viem'
import * as Credential from '../../Credential.js'
import * as ChannelStore from './ChannelStore.js'
import { createSessionReceipt } from './Receipt.js'
import type { NeedVoucherEvent, SessionCredentialPayload, SessionReceipt } from './Types.js'

/**
 * Format a session receipt as a Server-Sent Event.
 *
 * Produces a valid SSE event string with `event: payment-receipt`
 * and the receipt JSON as the `data` field.
 */
export function formatReceiptEvent(receipt: SessionReceipt): string {
  return `event: payment-receipt\ndata: ${JSON.stringify(receipt)}\n\n`
}

/**
 * Format a need-voucher event as a Server-Sent Event.
 *
 * Emitted when the channel balance is exhausted mid-stream.
 * The client responds by sending a new voucher credential to
 * any mppx-protected endpoint.
 */
export function formatNeedVoucherEvent(params: NeedVoucherEvent): string {
  return `event: payment-need-voucher\ndata: ${JSON.stringify(params)}\n\n`
}

/**
 * Parsed SSE event (discriminated union by `type`).
 */
export type SseEvent =
  | { type: 'message'; data: string }
  | { type: 'payment-need-voucher'; data: NeedVoucherEvent }
  | { type: 'payment-receipt'; data: SessionReceipt }

/**
 * Parse a raw SSE event string into a typed event.
 *
 * Handles the three event types used by mppx streaming:
 * - `message` (default / no event field) — application data
 * - `payment-need-voucher` — balance exhausted, client should send voucher
 * - `payment-receipt` — final receipt
 */
export function parseEvent(raw: string): SseEvent | null {
  let eventType = 'message'
  const dataLines: string[] = []

  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) {
      eventType = line.slice(7).trim()
    } else if (line.startsWith('data: ')) {
      dataLines.push(line.slice(6))
    } else if (line === 'data:') {
      dataLines.push('')
    }
  }

  if (dataLines.length === 0) return null
  const data = dataLines.join('\n')

  switch (eventType) {
    case 'message':
      return { type: 'message', data }
    case 'payment-need-voucher':
      return { type: 'payment-need-voucher', data: JSON.parse(data) as NeedVoucherEvent }
    case 'payment-receipt':
      return { type: 'payment-receipt', data: JSON.parse(data) as SessionReceipt }
    default:
      return { type: 'message', data }
  }
}

export type SessionController = {
  charge(): Promise<void>
}

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
 * 1. Deducts `tickCost` from the channel balance atomically (auto or manual).
 * 2. If balance is sufficient, emits `event: message` with the value.
 * 3. If balance is exhausted, emits `event: payment-need-voucher`
 *    and polls store until the client tops up the channel.
 * 4. On generator completion, emits a final `event: payment-receipt`.
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

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const aborted = () => signal?.aborted ?? false
      const emit = (event: string) => controller.enqueue(encoder.encode(event))

      const charge = () =>
        chargeOrWait({
          store,
          channelId,
          amount: tickCost,
          emit,
          pollIntervalMs,
          signal,
        })

      const iterable: AsyncIterable<string> =
        typeof generate === 'function' ? generate({ charge }) : generate

      try {
        for await (const value of iterable) {
          if (aborted()) break

          if (typeof generate !== 'function') await charge()

          controller.enqueue(encoder.encode(`event: message\ndata: ${value}\n\n`))
        }

        if (!aborted()) {
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
          }
        }
      } catch (e) {
        if (!aborted()) controller.error(e)
      } finally {
        controller.close()
      }
    },
  })
}

export declare namespace serve {
  type Options = {
    store: ChannelStore.ChannelStore
    channelId: Hex
    challengeId: string
    tickCost: bigint
    generate: AsyncIterable<string> | ((stream: SessionController) => AsyncIterable<string>)
    pollIntervalMs?: number | undefined
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
  const header = request.headers.get('Authorization')
  if (!header) throw new Error('Missing Authorization header.')

  const payment = Credential.extractPaymentScheme(header)
  if (!payment) throw new Error('Missing Payment credential in Authorization header.')

  const credential = Credential.deserialize(payment)
  const payload = credential.payload as SessionCredentialPayload
  return {
    challengeId: credential.challenge.id,
    channelId: payload.channelId,
    tickCost: BigInt(credential.challenge.request.amount as string),
  }
}

export declare namespace fromRequest {
  type Context = {
    challengeId: string
    channelId: Hex
    tickCost: bigint
  }
}

/**
 * Atomically deduct `amount` from a channel, retrying when balance is
 * insufficient. Uses `store.waitForUpdate()` when available for
 * event-driven wakeups, falling back to polling otherwise. Emits
 * `payment-need-voucher` events via `emit` while waiting.
 */
async function chargeOrWait(options: {
  store: ChannelStore.ChannelStore
  channelId: Hex
  amount: bigint
  emit: (event: string) => void
  pollIntervalMs: number
  signal?: AbortSignal | undefined
}): Promise<void> {
  const { store, channelId, amount, emit, pollIntervalMs, signal } = options

  let result = await ChannelStore.deductFromChannel(store, channelId, amount)

  if (!result.ok) {
    // Emit a single need-voucher event, then poll/wait until the client
    // sends an updated voucher. The requiredCumulative is constant here:
    // `spent` only changes on successful deduction (which exits the loop),
    // so re-emitting on every poll cycle would just cause redundant
    // voucher POSTs from the client.
    emit(
      formatNeedVoucherEvent({
        channelId,
        requiredCumulative: (result.channel.spent + amount).toString(),
        acceptedCumulative: result.channel.highestVoucherAmount.toString(),
        deposit: result.channel.deposit.toString(),
      }),
    )

    while (!result.ok) {
      await waitForUpdate(store, channelId, pollIntervalMs, signal)
      result = await ChannelStore.deductFromChannel(store, channelId, amount)
    }
  }
}

async function waitForUpdate(
  store: ChannelStore.ChannelStore,
  channelId: Hex,
  pollIntervalMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error('Aborted while waiting for voucher')
  if (store.waitForUpdate) {
    await Promise.race([store.waitForUpdate(channelId), ...(signal ? [abortPromise(signal)] : [])])
  } else {
    await sleep(pollIntervalMs)
  }
  if (signal?.aborted) throw new Error('Aborted while waiting for voucher')
}

function abortPromise(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
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
      if (done) break

      buffer += decoder.decode(value, { stream: true })

      // Split on double-newline SSE event boundaries.
      const events = buffer.split('\n\n')
      // Last element may be incomplete — keep in buffer.
      buffer = events.pop() ?? ''

      for (const event of events) {
        if (!event.trim()) continue
        const data = extractData(event)
        if (data === null) continue
        if (skip?.(data)) continue
        yield data
      }
    }

    // Flush remaining buffer.
    if (buffer.trim()) {
      const data = extractData(buffer)
      if (data !== null && !skip?.(data)) yield data
    }
  } finally {
    reader.releaseLock()
  }
}

export declare namespace iterateData {
  type Options = {
    /** Predicate to skip specific data payloads (e.g. `d => d === '[DONE]'`). */
    skip?: ((data: string) => boolean) | undefined
  }
}

/** Extract the `data:` field value from a single SSE event block. */
function extractData(event: string): string | null {
  const dataLines: string[] = []
  for (const line of event.split('\n')) {
    if (line.startsWith('data: ')) dataLines.push(line.slice(6))
    else if (line === 'data:') dataLines.push('')
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null
}
