import * as Transport from '../../server/Transport.js'
import * as Sse from '../stream/Sse.js'
import type { ChannelStorage, Storage } from '../stream/Storage.js'
import { channelStorage as toChannelStorage } from '../stream/Storage.js'

export function sseTransport(config: sseTransport.Config) {
  const { storage: rawStorage, pollIntervalMs, pollingOnly } = config
  const fullStorage = toChannelStorage(rawStorage)
  // When pollingOnly is true, strip waitForUpdate so the SSE charge loop
  // falls back to polling. This is needed for runtimes like Cloudflare Workers
  // where resolving promises across request contexts is not supported.
  const storage: ChannelStorage = pollingOnly
    ? {
        getChannel: fullStorage.getChannel.bind(fullStorage),
        updateChannel: fullStorage.updateChannel.bind(fullStorage),
      }
    : fullStorage
  const httpTransport = Transport.http()

  const contextMap = new Map<string, Sse.fromRequest.Context>()

  return Transport.from<
    Request,
    Response,
    Response | AsyncIterable<string> | ((stream: Sse.StreamController) => AsyncIterable<string>)
  >({
    name: 'sse',

    getCredential(request) {
      const credential = httpTransport.getCredential(request)
      if (credential) {
        try {
          const ctx = Sse.fromRequest(request)
          contextMap.set(ctx.challengeId, ctx)
        } catch {
          // ignore — non-SSE credentials won't have stream context
        }
      }
      return credential
    },

    respondChallenge(options) {
      return httpTransport.respondChallenge(options)
    },

    respondReceipt({ receipt, response, challengeId }) {
      if (isAsyncGeneratorFunction(response) || isAsyncIterable(response)) {
        const ctx = contextMap.get(challengeId)
        if (!ctx) throw new Error('No SSE context available — credential was not parsed')
        contextMap.delete(challengeId)

        // Pass async generator functions directly so Sse.serve gives them
        // a StreamController for manual charge(). Pass raw AsyncIterables
        // as-is so Sse.serve auto-charges per yielded value.
        const generate: Sse.serve.Options['generate'] = isAsyncGeneratorFunction(response)
          ? (response as Sse.serve.Options['generate'])
          : (response as AsyncIterable<string>)
        const stream = Sse.serve({
          storage,
          channelId: ctx.channelId,
          challengeId,
          tickCost: ctx.tickCost,
          generate,
          pollIntervalMs,
        })
        return Sse.toResponse(stream)
      }

      return httpTransport.respondReceipt({ receipt, response: response as Response, challengeId })
    },
  })
}

export declare namespace sseTransport {
  type Config = {
    storage: Storage
    pollIntervalMs?: number | undefined
    /**
     * When true, the SSE charge loop uses polling instead of `waitForUpdate()`.
     *
     * Required for runtimes like Cloudflare Workers where resolving promises
     * across request contexts is not supported. Without this flag, a mid-stream
     * voucher POST (Request B) would resolve a waiter created in the SSE
     * stream's request context (Request A), causing a Workers error.
     *
     * @default false
     */
    pollingOnly?: boolean | undefined
  }
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
