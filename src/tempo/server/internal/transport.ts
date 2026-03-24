/**
 * Tempo-specific SSE transport that wraps the base HTTP transport
 * with metering logic (context capture from credentials, per-token
 * charging via Sse.serve).
 *
 * @internal
 */
import * as Transport from '../../../server/Transport.js'
import * as ChannelStore from '../../session/ChannelStore.js'
import * as Sse_core from '../../session/Sse.js'

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

  const contextMap = new Map<string, Sse_core.fromRequest.Context & { signal?: AbortSignal }>()

  const base = Transport.http()
  return Transport.from<Request, Response, Transport.ReceiptResponseOf<Sse>, Response>({
    name: 'sse',

    getCredential(request) {
      const credential = base.getCredential(request)
      if (credential) {
        try {
          const ctx = Sse_core.fromRequest(request)
          contextMap.set(ctx.challengeId, { ...ctx, signal: request.signal })
        } catch {
          // ignore — non-SSE credentials won't have session context
        }
      }
      return credential
    },

    respondChallenge(options) {
      return base.respondChallenge(options) as Response
    },

    respondReceipt({ receipt, response, challengeId }) {
      // Auto-detect upstream SSE responses and parse them into an
      // AsyncIterable so they flow through the metered pipeline.
      // This lets proxy consumers simply pass `result.withReceipt(upstreamRes)`
      // and get per-event charging automatically.
      const resolved =
        response instanceof Response && Sse_core.isEventStream(response) && response.body
          ? Sse_core.iterateData(response, { skip: (d) => d === '[DONE]' })
          : response

      if (isAsyncGeneratorFunction(resolved) || isAsyncIterable(resolved)) {
        const ctx = contextMap.get(challengeId)
        if (!ctx) throw new Error('No SSE context available — credential was not parsed')
        contextMap.delete(challengeId)

        // Pass async generator functions directly so Sse.serve gives them
        // a SessionController for manual charge(). Pass raw AsyncIterables
        // as-is so Sse.serve auto-charges per yielded value.
        const generate: Sse_core.serve.Options['generate'] = isAsyncGeneratorFunction(resolved)
          ? (resolved as Sse_core.serve.Options['generate'])
          : (resolved as AsyncIterable<string>)
        const stream = Sse_core.serve({
          store,
          channelId: ctx.channelId,
          challengeId,
          tickCost: ctx.tickCost,
          pollIntervalMs: pollingInterval,
          generate,
          signal: ctx.signal,
        })
        return Sse_core.toResponse(stream)
      }

      const baseResponse = base.respondReceipt({
        receipt,
        response: response as Response,
        challengeId,
      })

      // Non-SSE response (e.g. upstream returned JSON instead of event-stream).
      // Need to deduct tickCost so request isn't free.
      const ctx = contextMap.get(challengeId)
      if (ctx) {
        contextMap.delete(challengeId)

        // Null-body statuses (e.g. 204 from management actions) cannot carry a
        // response body per Fetch/HTTP semantics.
        if (isNullBodyStatus(baseResponse.status)) {
          return baseResponse
        }

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            // deduction completes before consumer reads
            await ChannelStore.deductFromChannel(store, ctx.channelId, ctx.tickCost)
            if (!baseResponse.body) {
              controller.close()
              return
            }
            const reader = baseResponse.body.getReader()
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
          status: baseResponse.status,
          statusText: baseResponse.statusText,
          headers: baseResponse.headers,
        })
      }

      return baseResponse
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

function isNullBodyStatus(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304
}
