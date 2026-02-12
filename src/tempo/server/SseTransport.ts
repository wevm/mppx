import * as Transport from '../../server/Transport.js'
import * as Sse from '../stream/Sse.js'
import type { Storage } from '../stream/Storage.js'
import { channelStorage as toChannelStorage } from '../stream/Storage.js'

export function sseTransport(config: sseTransport.Config) {
  const { storage: rawStorage, pollIntervalMs } = config
  const storage = toChannelStorage(rawStorage)
  const httpTransport = Transport.http()

  let lastContext: Sse.fromRequest.Context | null = null

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
          lastContext = Sse.fromRequest(request)
        } catch {
          lastContext = null
        }
      }
      return credential
    },

    respondChallenge(options) {
      return httpTransport.respondChallenge(options)
    },

    respondReceipt({ receipt, response, challengeId }) {
      if (isAsyncGeneratorFunction(response) || isAsyncIterable(response)) {
        if (!lastContext) throw new Error('No SSE context available — credential was not parsed')

        const generate = typeof response === 'function' ? response : () => response
        const stream = Sse.serve({
          storage,
          channelId: lastContext.channelId,
          challengeId,
          tickCost: lastContext.tickCost,
          generate: generate as Sse.serve.Options['generate'],
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
