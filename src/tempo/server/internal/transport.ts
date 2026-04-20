/**
 * Tempo-specific SSE transport that wraps the base HTTP transport
 * with metering logic (context capture from verified credentials, per-token
 * charging via Sse.serve).
 *
 * @internal
 */
import * as Challenge from '../../../Challenge.js'
import * as Errors from '../../../Errors.js'
import * as Transport from '../../../server/Transport.js'
import * as ChannelStore from '../../session/ChannelStore.js'
import * as Sse_core from '../../session/Sse.js'
import type { SessionCredentialPayload, SessionReceipt } from '../../session/Types.js'

/** SSE transport with Tempo session controller. */
export type Sse = Transport.Sse<Sse_core.SessionController>

/**
 * Creates a Tempo-metered SSE transport.
 *
 * Wraps an HTTP transport with:
 * - Context capture from credentials (channelId, tickCost)
 * - Per-token charging via Sse.serve for generator/iterable responses
 * - Auto-detection of upstream SSE responses
 * - Fallback to standard HTTP receipt handling for plain Response
 */
export function sse(options: sse.Options & { store: ChannelStore.ChannelStore }): Sse {
  const { pollingInterval, poll } = options

  // When `poll` is true, strip `waitForUpdate` so the SSE charge loop
  // falls back to polling. This is needed for runtimes like Cloudflare Workers
  // where resolving promises across request contexts is not supported.
  const store = (() => {
    if (!poll) return options.store
    const { waitForUpdate: _, ...store } = options.store
    return store
  })()

  const base = Transport.http()
  return Transport.from<Request, Response, Transport.ReceiptResponseOf<Sse>, Response>({
    name: 'sse',

    captureRequest(request) {
      return (
        base.captureRequest?.(request) ?? {
          hasBody: request.body !== null,
          headers: new Headers(request.headers),
          method: request.method,
          url: new URL(request.url),
        }
      )
    },

    getCredential(request) {
      return base.getCredential(request)
    },

    respondChallenge(options) {
      return base.respondChallenge(options) as Response
    },

    respondReceipt({ credential, envelope, receipt, response, challengeId, input }) {
      const verifiedCredential = envelope?.credential ?? credential
      const verifiedChallengeId = envelope?.challenge.id ?? challengeId
      const payload = verifiedCredential.payload as Partial<SessionCredentialPayload>
      if (!payload.channelId) throw new Error('No SSE context available')
      const channelId = payload.channelId
      const tickCost = BigInt(verifiedCredential.challenge.request.amount as string)
      const unitType =
        typeof verifiedCredential.challenge.request.unitType === 'string'
          ? verifiedCredential.challenge.request.unitType
          : undefined

      // Auto-detect upstream SSE responses and parse them into an
      // AsyncIterable so they flow through the metered pipeline.
      // This lets proxy consumers simply pass `result.withReceipt(upstreamRes)`
      // and get per-event charging automatically.
      const resolved =
        response instanceof Response && Sse_core.isEventStream(response) && response.body
          ? Sse_core.iterateData(response, { skip: (d) => d === '[DONE]' })
          : response

      if (isAsyncGeneratorFunction(resolved) || isAsyncIterable(resolved)) {
        // Pass async generator functions directly so Sse.serve gives them
        // a SessionController for manual charge(). Pass raw AsyncIterables
        // as-is so Sse.serve auto-charges per yielded value.
        const generate = resolveMeteredGenerate(resolved, unitType)
        const stream = Sse_core.serve({
          store,
          channelId,
          challengeId: verifiedChallengeId,
          tickCost,
          pollIntervalMs: pollingInterval,
          generate,
          signal: input.signal,
        })
        return Sse_core.toResponse(stream)
      }

      const baseResponse = base.respondReceipt({
        credential: verifiedCredential,
        envelope,
        input,
        receipt,
        response: response as Response,
        challengeId: verifiedChallengeId,
      })

      if (!shouldChargePlainResponse(input, payload)) {
        return baseResponse
      }

      const currentReceipt = receipt as SessionReceipt
      const available = BigInt(currentReceipt.acceptedCumulative) - BigInt(currentReceipt.spent)
      if (available < tickCost) {
        const error = new Errors.InsufficientBalanceError({
          reason: `requested ${tickCost}, available ${available}`,
        })
        return new Response(
          JSON.stringify(error.toProblemDetails(verifiedCredential.challenge.id)),
          {
            status: error.status,
            headers: {
              'WWW-Authenticate': Challenge.serialize(verifiedCredential.challenge),
              'Cache-Control': 'no-store',
              'Content-Type': 'application/problem+json',
            },
          },
        )
      }

      const chargedReceipt: SessionReceipt = {
        ...currentReceipt,
        spent: (BigInt(currentReceipt.spent) + tickCost).toString(),
        units: (currentReceipt.units ?? 0) + 1,
      }
      const chargedResponse = base.respondReceipt({
        credential: verifiedCredential,
        envelope,
        input,
        receipt: chargedReceipt,
        response: response as Response,
        challengeId: verifiedChallengeId,
      })

      // Non-SSE response (e.g. upstream returned JSON instead of event-stream).
      // Need to deduct tickCost so request isn't free.
      // For null-body statuses, the request shape determines whether the
      // response is management (no charge) or plain content (charge one tick).
      if (isNullBodyStatus(chargedResponse.status)) {
        void ChannelStore.deductFromChannel(store, channelId, tickCost)
        return chargedResponse
      }

      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          // deduction completes before consumer reads
          const result = await ChannelStore.deductFromChannel(store, channelId, tickCost)
          if (!result.ok) {
            controller.error(
              new Errors.InsufficientBalanceError({
                reason: `requested ${tickCost}, available ${
                  result.channel.highestVoucherAmount - result.channel.spent
                }`,
              }),
            )
            return
          }
          if (!chargedResponse.body) {
            controller.close()
            return
          }
          const reader = chargedResponse.body.getReader()
          try {
            while (true) {
              const { done, value } = await reader.read()
              if (done) break
              controller.enqueue(value)
            }
          } finally {
            reader.releaseLock()
            controller.close()
          }
        },
      })
      return new Response(stream, {
        status: chargedResponse.status,
        statusText: chargedResponse.statusText,
        headers: chargedResponse.headers,
      })
    },
  })
}

export declare namespace sse {
  type Options = {
    /**
     * When true, the charge loop uses polling instead of `waitForUpdate()`.
     *
     * Required for runtimes like Cloudflare Workers where resolving promises
     * across request contexts is not supported. Without this flag, a mid-stream
     * voucher POST (Request B) would resolve a waiter created in the streaming
     * request context (Request A), causing a Workers error.
     *
     * @default false
     */
    poll?: boolean | undefined
    /** Polling interval (in milliseconds). @default 10 */
    pollingInterval?: number | undefined
  }
}

/** Default SSE serve: iterates values and emits `event: message` per value. */
export function defaultServe(options: {
  generate: AsyncIterable<string> | ((...args: any[]) => AsyncIterable<string>)
  challengeId: string
}): Response {
  const iterable =
    typeof options.generate === 'function' ? options.generate(undefined as any) : options.generate
  const encoder = new TextEncoder()
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        for await (const value of iterable) {
          controller.enqueue(encoder.encode(`event: message\ndata: ${value}\n\n`))
        }
      } catch (e) {
        controller.error(e)
      } finally {
        controller.close()
      }
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  })
}

function isAsyncGeneratorFunction(
  value: unknown,
): value is (...args: unknown[]) => AsyncIterable<string> {
  if (typeof value !== 'function') return false
  return value.constructor?.name === 'AsyncGeneratorFunction'
}

function isAsyncIterable(value: unknown): value is AsyncIterable<string> {
  return value !== null && typeof value === 'object' && Symbol.asyncIterator in (value as object)
}

function resolveMeteredGenerate(
  value: AsyncIterable<string> | ((...args: unknown[]) => AsyncIterable<string>),
  unitType: string | undefined,
): Sse_core.serve.Options['generate'] {
  if (isAsyncGeneratorFunction(value)) return value as Sse_core.serve.Options['generate']
  if (unitType !== 'request') return value as AsyncIterable<string>

  const iterable = value as AsyncIterable<string>
  return async function* chargeOnce(stream) {
    let charged = false
    for await (const chunk of iterable) {
      if (!charged) {
        await stream.charge()
        charged = true
      }
      yield chunk
    }
  }
}

function isNullBodyStatus(status: number): boolean {
  return [101, 204, 205, 304].includes(status)
}

function shouldChargePlainResponse(
  input: Request,
  payload: Partial<SessionCredentialPayload>,
): boolean {
  if (payload.action === 'close' || payload.action === 'topUp') return false
  if (input.method !== 'POST') return true

  const contentLength = input.headers.get('content-length')
  if (contentLength !== null && contentLength !== '0') return true
  if (input.headers.has('transfer-encoding')) return true

  return false
}
