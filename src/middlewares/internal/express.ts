import { PassThrough, Readable } from 'node:stream'

import type { Request as ExpressRequest, Response as ExpressResponse } from 'express'

import * as NodeListener from '../../server/NodeListener.js'
import * as NodeRequest from './node.js'

/** Copies Fetch response headers to an Express response. */
export function copyHeaders(response: ExpressResponse, headers: Headers): void {
  for (const [name, value] of headers) response.setHeader(name, value)
}

/** Sends a Fetch response through Express without changing its status, headers, or bytes. */
export async function sendResponse(response: ExpressResponse, fetchResponse: Response) {
  copyHeaders(response, fetchResponse.headers)
  response.status(fetchResponse.status)
  if (fetchResponse.body === null) return response.end()
  return response.send(Buffer.from(await fetchResponse.arrayBuffer()))
}

/** Converts an Express parsed request into the Fetch request consumed by mppx core. */
export function toRequest(request: ExpressRequest): Request {
  return NodeRequest.toRequest({
    body: request.body,
    headers: request.headers,
    method: request.method,
    url: `${request.protocol}://${request.get('host')}${request.originalUrl}`,
  })
}

/**
 * Gates every Express output path through the payment transport before sending
 * headers or bytes. The bounded stream preserves pipe backpressure while the
 * transport validates and meters the response.
 */
export function wrapResponse(
  response: ExpressResponse,
  withReceipt: (response: Response) => Response | Promise<Response>,
  onError: (error: unknown) => void,
): void {
  const body = new PassThrough()
  const original = {
    write: response.write.bind(response),
    end: response.end.bind(response),
    writeHead: response.writeHead.bind(response),
    flushHeaders: response.flushHeaders.bind(response),
    addTrailers: response.addTrailers.bind(response),
  }
  type Callback = (error?: Error | null) => void
  const callbacks: Callback[] = []
  const endCallbacks: Callback[] = []
  let trailers: Parameters<typeof response.addTrailers>[0] | undefined
  let emitting = false
  let failed: Error | undefined
  let started = false
  let accepted = false

  function complete(pending: Callback[], error?: Error) {
    for (const callback of pending.splice(0)) queueMicrotask(() => callback(error))
  }

  // Keep downstream middleware hooks in the output chain. Only synchronous native
  // emission may bypass the gate; later writes from the handler stay intercepted.
  function emit<T>(run: () => T): T {
    emitting = true
    try {
      return run()
    } finally {
      emitting = false
    }
  }
  const output = new Proxy(response, {
    get(target, property) {
      if (property === 'write')
        return (chunk: Uint8Array) => {
          const pending = callbacks.splice(0)
          return emit(() => response.write(chunk, (error) => complete(pending, error ?? undefined)))
        }
      if (property === 'end')
        return () =>
          emit(() => {
            if (accepted && trailers) response.addTrailers(trailers)
            return response.end(() => {
              complete(callbacks, failed)
              complete(endCallbacks, failed)
            })
          })
      if (property === 'writeHead')
        return (...args: Parameters<typeof response.writeHead>) =>
          emit(() => response.writeHead(...args))
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  body.on('drain', () => {
    if (!response.writableNeedDrain) response.emit('drain')
  })
  body.on('error', () => {})
  response.once('close', () => {
    body.destroy()
    if (!response.writableFinished) {
      const error = failed ?? new Error('Response closed before paid delivery completed.')
      complete(callbacks, error)
      complete(endCallbacks, error)
    }
  })

  function start() {
    if (started) return
    started = true
    // Run downstream implicit-header hooks before the transport selects metering.
    response.writeHead(response.statusCode)
    const headers = new Headers()
    for (const [name, value] of Object.entries(response.getHeaders())) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item)
      else if (value !== undefined) headers.set(name, String(value))
    }
    const status = response.statusCode
    const hasBody = ![204, 205, 304].includes(status)
    const stream = Readable.toWeb(body, {
      strategy: { highWaterMark: 1 },
    }) as ReadableStream<Uint8Array>
    if (!hasBody) body.resume()
    void Promise.resolve()
      .then(() =>
        withReceipt(
          new Response(hasBody ? stream : null, {
            headers,
            status,
            statusText: response.statusMessage,
          }),
        ),
      )
      .then(async (wrapped) => {
        accepted = wrapped.status === status
        if (!accepted) {
          failed = new Error('Payment transport rejected the content response.')
          body.destroy()
          complete(callbacks, failed)
          complete(endCallbacks, failed)
        }
        for (const name of response.getHeaderNames()) response.removeHeader(name)
        await NodeListener.sendResponse(output, wrapped)
      })
      .catch((error: unknown) => {
        failed = error instanceof Error ? error : new Error(String(error))
        body.destroy()
        complete(callbacks, failed)
        complete(endCallbacks, failed)
        // Never reopen raw output while an asynchronous handler is still running.
        response.destroy()
        onError(error)
      })
  }

  response.write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | Callback,
    callback?: Callback,
  ) => {
    if (emitting) return original.write(chunk, encoding as BufferEncoding, callback)
    const done = typeof encoding === 'function' ? encoding : callback
    if (failed || response.destroyed) {
      if (done) queueMicrotask(() => done(failed ?? new Error('Response closed.')))
      return false
    }
    if (done) callbacks.push(done)
    start()
    // A transport may retain the chunk after the producer's callback runs.
    const copy =
      typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined)
        : Buffer.from(chunk)
    return body.write(copy)
  }) as typeof response.write
  response.end = ((
    chunk?: string | Uint8Array | Callback,
    encoding?: BufferEncoding | Callback,
    callback?: Callback,
  ) => {
    if (emitting) return original.end(chunk as string, encoding as BufferEncoding, callback)
    const done =
      typeof chunk === 'function' ? chunk : typeof encoding === 'function' ? encoding : callback
    if (done) endCallbacks.push(done)
    if (typeof chunk === 'string' || chunk instanceof Uint8Array)
      response.write(chunk, typeof encoding === 'string' ? encoding : 'utf8')
    start()
    body.end()
    if (failed) complete(endCallbacks, failed)
    return response
  }) as typeof response.end
  response.writeHead = ((status: number, messageOrHeaders?: string | object, headers?: object) => {
    if (emitting) return original.writeHead(status, messageOrHeaders as string, headers as never)
    if (failed || response.destroyed) return response
    response.statusCode = status
    if (typeof messageOrHeaders === 'string') response.statusMessage = messageOrHeaders
    const values = headers ?? (typeof messageOrHeaders === 'string' ? undefined : messageOrHeaders)
    if (Array.isArray(values)) {
      const seen = new Set<string>()
      for (let i = 0; i < values.length; i += 2) {
        const name = String(values[i])
        if (!seen.has(name.toLowerCase())) response.removeHeader(name)
        response.appendHeader(name, values[i + 1])
        seen.add(name.toLowerCase())
      }
    } else if (values) {
      for (const [name, value] of Object.entries(values)) response.setHeader(name, value)
    }
    start()
    return response
  }) as typeof response.writeHead
  response.flushHeaders = () => {
    if (emitting) original.flushHeaders()
    else start()
  }
  response.addTrailers = (values) => {
    if (emitting) original.addTrailers(values)
    else trailers = values
  }
  // Hints are optional and must not reveal protected metadata before accounting.
  response.writeEarlyHints = (_hints, callback) => {
    callback?.()
  }
}
