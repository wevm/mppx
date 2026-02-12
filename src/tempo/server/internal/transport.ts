/**
 * Tempo-specific SSE transport that wraps the base HTTP transport
 * with metering logic (context capture from credentials, per-token
 * charging via Sse.serve).
 *
 * @internal
 */
import * as Transport from '../../../server/Transport.js'
import * as Sse_core from '../../stream/Sse.js'
import type { ChannelStorage } from '../../stream/Storage.js'

/** SSE transport with Tempo stream controller. */
export type Sse = Transport.Sse<Sse_core.StreamController>

/**
 * Creates a Tempo-metered SSE transport.
 *
 * Wraps an HTTP transport with:
 * - Context capture from credentials (channelId, tickCost)
 * - Per-token charging via Sse.serve for generator/iterable responses
 * - Fallback to standard HTTP receipt handling for plain Response
 */
export function sse(storage: ChannelStorage): Sse {
  const base = Transport.http()

  let context: Sse_core.fromRequest.Context | null = null

  return Transport.from<Request, Response, Transport.ReceiptOutputOf<Sse>, Response>({
    name: 'sse',

    getCredential(request) {
      const credential = base.getCredential(request)
      if (credential) {
        try {
          context = Sse_core.fromRequest(request)
        } catch {
          context = null
        }
      }
      return credential
    },

    respondChallenge(options) {
      return base.respondChallenge(options) as Response
    },

    respondReceipt({ receipt, response, challengeId }) {
      if (
        typeof response === 'function' ||
        (response !== null && typeof response === 'object' && Symbol.asyncIterator in response)
      ) {
        if (!context) throw new Error('No SSE context available — credential was not parsed')
        const generate =
          typeof response === 'function' ? response : () => response as AsyncIterable<string>
        const stream = Sse_core.serve({
          storage,
          channelId: context.channelId,
          challengeId,
          tickCost: context.tickCost,
          generate: generate as Sse_core.serve.Options['generate'],
        })
        return Sse_core.toResponse(stream)
      }
      return base.respondReceipt({ receipt, response: response as Response, challengeId })
    },
  })
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
