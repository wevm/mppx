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
import { createStreamReceipt } from './Receipt.js'
import type { ChannelStorage } from './Storage.js'
import { deductFromChannel } from './Storage.js'
import type { NeedVoucherEvent, StreamCredentialPayload, StreamReceipt } from './Types.js'

/**
 * Format a stream receipt as a Server-Sent Event.
 *
 * Produces a valid SSE event string with `event: payment-receipt`
 * and the receipt JSON as the `data` field.
 */
export function formatReceiptEvent(receipt: StreamReceipt): string {
  return `event: payment-receipt\ndata: ${JSON.stringify(receipt)}\n\n`
}

/**
 * Format a need-voucher event as a Server-Sent Event.
 *
 * Emitted when the channel balance is exhausted mid-stream.
 * The client responds by sending a new voucher credential to
 * any mpay-protected endpoint.
 */
export function formatNeedVoucherEvent(params: NeedVoucherEvent): string {
  return `event: 402-need-voucher\ndata: ${JSON.stringify(params)}\n\n`
}

/**
 * Parsed SSE event (discriminated union by `type`).
 */
export type SseEvent =
  | { type: 'message'; data: string }
  | { type: '402-need-voucher'; data: NeedVoucherEvent }
  | { type: 'payment-receipt'; data: StreamReceipt }

/**
 * Parse a raw SSE event string into a typed event.
 *
 * Handles the three event types used by mpay streaming:
 * - `message` (default / no event field) — application data
 * - `402-need-voucher` — balance exhausted, client should send voucher
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
    case '402-need-voucher':
      return { type: '402-need-voucher', data: JSON.parse(data) as NeedVoucherEvent }
    case 'payment-receipt':
      return { type: 'payment-receipt', data: JSON.parse(data) as StreamReceipt }
    default:
      return { type: 'message', data }
  }
}

export type StreamController = {
  charge(): Promise<void>
}

/**
 * Wrap an async iterable with payment metering, producing an SSE stream.
 *
 * `generate` may be either:
 * - An `AsyncIterable<string>` — each yielded value is automatically charged
 *   (one `tickCost` per value).
 * - A callback `(stream: StreamController) => AsyncIterable<string>` — the
 *   generator controls when charges happen by calling `stream.charge()`.
 *
 * For each emitted value the stream:
 * 1. Deducts `tickCost` from the channel balance atomically (auto or manual).
 * 2. If balance is sufficient, emits `event: message` with the value.
 * 3. If balance is exhausted, emits `event: 402-need-voucher`
 *    and polls storage until the client tops up the channel.
 * 4. On generator completion, emits a final `event: payment-receipt`.
 *
 * Returns a `ReadableStream<Uint8Array>` suitable for use as an HTTP response body.
 */
export function serve(options: serve.Options): ReadableStream<Uint8Array> {
  const {
    storage,
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
          storage,
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
          const channel = await storage.getChannel(channelId)
          if (channel) {
            const receipt = createStreamReceipt({
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
    storage: ChannelStorage
    channelId: Hex
    challengeId: string
    tickCost: bigint
    generate: AsyncIterable<string> | ((stream: StreamController) => AsyncIterable<string>)
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
  const payload = credential.payload as StreamCredentialPayload
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
 * insufficient. Uses `storage.waitForUpdate()` when available for
 * event-driven wakeups, falling back to polling otherwise. Emits
 * `402-need-voucher` events via `emit` while waiting.
 */
async function chargeOrWait(options: {
  storage: ChannelStorage
  channelId: Hex
  amount: bigint
  emit: (event: string) => void
  pollIntervalMs: number
  signal?: AbortSignal | undefined
}): Promise<void> {
  const { storage, channelId, amount, emit, pollIntervalMs, signal } = options

  let result = await deductFromChannel(storage, channelId, amount)

  while (!result.ok) {
    const requiredCumulative = (result.channel.spent + amount).toString()
    emit(
      formatNeedVoucherEvent({
        channelId,
        requiredCumulative,
        acceptedCumulative: result.channel.highestVoucherAmount.toString(),
      }),
    )

    await waitForUpdate(storage, channelId, pollIntervalMs, signal)
    result = await deductFromChannel(storage, channelId, amount)
  }
}

async function waitForUpdate(
  storage: ChannelStorage,
  channelId: Hex,
  pollIntervalMs: number,
  signal?: AbortSignal,
): Promise<void> {
  if (signal?.aborted) throw new Error('Aborted while waiting for voucher')
  if (storage.waitForUpdate) {
    await Promise.race([
      storage.waitForUpdate(channelId),
      ...(signal ? [abortPromise(signal)] : []),
    ])
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
