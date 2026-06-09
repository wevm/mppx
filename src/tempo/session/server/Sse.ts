import type { Hex } from 'viem'

import * as Constants from '../../../Constants.js'
import * as Credential from '../../../Credential.js'
import {
  createSessionReceipt,
  extractData,
  formatMessageEvent,
  formatNeedVoucherEvent,
  formatReceiptEvent,
  parseEvent,
  readSessionChallengeAmount,
  requireSessionCredentialContext,
  type SseEvent,
} from '../precompile/Protocol.js'
import * as ChannelStore from './ChannelStore.js'
import { meterIterable, type SessionController } from './MeteredStream.js'

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
 * 4. Commits the reserved charge immediately before the chunk is emitted.
 * 5. On generator completion, emits a final `event: payment-receipt`.
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

      try {
        for await (const value of meterIterable({
          store,
          channelId,
          tickCost,
          generate,
          pollIntervalMs,
          prepaidUnits: options.prepaidUnits,
          signal,
          emitNeedVoucher: emit,
          formatNeedVoucher: formatNeedVoucherEvent,
        })) {
          if (aborted()) break
          controller.enqueue(encoder.encode(formatMessageEvent(value)))
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

/** Type helpers for {@link serve}. */
export declare namespace serve {
  type Options = {
    store: ChannelStore.ChannelStore
    channelId: Hex
    challengeId: string
    tickCost: bigint
    generate: AsyncIterable<string> | ((stream: SessionController) => AsyncIterable<string>)
    pollIntervalMs?: number | undefined
    prepaidUnits?: number | undefined
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

/** Type helpers for {@link iterateData}. */
export declare namespace iterateData {
  type Options = {
    /** Predicate to skip specific data payloads (e.g. `d => d === '[DONE]'`). */
    skip?: ((data: string) => boolean) | undefined
  }
}
