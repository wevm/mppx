import { OutgoingMessage } from 'node:http'
import { PassThrough } from 'node:stream'
import { finished } from 'node:stream/promises'

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
  const callbacks = new Set<Callback>()
  const endCallbacks: Callback[] = []
  const readyCallbacks: Callback[] = []
  let trailers: Parameters<typeof response.addTrailers>[0] | undefined
  let emitting = false
  let failed: Error | undefined
  let started = false
  let ready = false
  let consumed = false
  let hasBody = true
  let preserveTrailers = false
  let preparingHeaders = false
  let headersPrepared = false
  const nativeHeadersSent = Object.getOwnPropertyDescriptor(
    OutgoingMessage.prototype,
    'headersSent',
  )!.get!
  Object.defineProperty(response, 'headersSent', {
    configurable: true,
    get: () => (started && !preparingHeaders) || nativeHeadersSent.call(response),
  })

  function acknowledgeWrites() {
    if (!ready || !consumed || failed) return
    for (const callback of readyCallbacks.splice(0)) {
      if (callbacks.delete(callback)) queueMicrotask(() => callback())
    }
  }

  function complete(pending: Callback[] | Set<Callback>, error?: Error) {
    const entries = [...pending]
    if (pending instanceof Set) pending.clear()
    else pending.length = 0
    for (const callback of entries) queueMicrotask(() => callback(error))
  }

  // Handler bytes already passed through downstream body wrappers. Emit them natively
  // once; header hooks run separately before selecting the payment transport.
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
      if (property === 'write') return (chunk: Uint8Array) => emit(() => original.write(chunk))
      if (property === 'end')
        return () =>
          emit(() => {
            if (hasBody && !consumed)
              failed = new Error('Payment transport replaced the content response.')
            if (preserveTrailers && trailers) original.addTrailers(trailers)
            return original.end(() => {
              complete(callbacks, failed)
              complete(endCallbacks, failed)
            })
          })
      if (property === 'writeHead')
        return (...args: Parameters<typeof response.writeHead>) =>
          emit(() => original.writeHead(...args))
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
    preparingHeaders = true
    try {
      if (!headersPrepared) response.writeHead(response.statusCode)
    } finally {
      preparingHeaders = false
    }
    const headers = new Headers()
    for (const [name, value] of Object.entries(response.getHeaders())) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item)
      else if (value !== undefined) headers.set(name, String(value))
    }
    const status = response.statusCode
    hasBody = ![204, 205, 304].includes(status)
    const iterator = body[Symbol.asyncIterator]()
    let canceled = false
    const stream = new ReadableStream<Uint8Array>(
      {
        async pull(controller) {
          consumed = true
          acknowledgeWrites()
          try {
            const next = await iterator.next()
            if (canceled) return
            if (next.done) controller.close()
            else controller.enqueue(next.value)
          } catch (error) {
            if (!canceled) controller.error(error)
          }
        },
        cancel() {
          canceled = true
          body.destroy()
        },
      },
      { highWaterMark: 0 },
    )
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
        // Trailers describe the original body, not a replacement or transformed response.
        preserveTrailers = hasBody && wrapped.body === stream
        // HEAD deliberately omits an unchanged body without making delivery a failure.
        const head = response.req.method === 'HEAD' && preserveTrailers
        if (head) {
          consumed = true
          body.resume()
        }
        ready = true
        acknowledgeWrites()
        for (const name of response.getHeaderNames()) response.removeHeader(name)
        try {
          if (head) await finished(body, { cleanup: true })
          await NodeListener.sendResponse(output, wrapped)
        } finally {
          // A replacement response may finish without consuming the handler's body.
          body.destroy()
        }
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

  const write = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | Callback,
    callback?: Callback,
  ) => {
    if (emitting) return original.write(chunk, encoding as BufferEncoding, callback)
    const handler = typeof encoding === 'function' ? encoding : callback
    // Each write owns a completion, even when a producer reuses its callback.
    const done = handler ? (error?: Error | null) => handler(error) : undefined
    if (failed || response.destroyed || response.writableEnded || body.destroyed) {
      if (done) queueMicrotask(() => done(failed ?? new Error('Response closed.')))
      return false
    }
    if (done) callbacks.add(done)
    start()
    // A transport may retain the chunk after the producer's callback runs.
    const copy =
      typeof chunk === 'string'
        ? Buffer.from(chunk, typeof encoding === 'string' ? encoding : undefined)
        : Buffer.from(chunk)
    return body.write(copy, (error) => {
      if (!done || !callbacks.has(done)) return
      if (error) {
        callbacks.delete(done)
        queueMicrotask(() => done(error))
      } else {
        // The copied input has entered a bounded stream. Waiting for a complete
        // output event here deadlocks producers that write that event in pieces.
        readyCallbacks.push(done)
        acknowledgeWrites()
      }
    })
  }) as typeof response.write
  response.write = write
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
      write(chunk, typeof encoding === 'string' ? encoding : 'utf8')
    start()
    body.end()
    // Native end uncorks implicitly, but paid delivery must drain before it can run.
    while (response.writableCorked > 0) response.uncork()
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
    headersPrepared = true
    start()
    return response
  }) as typeof response.writeHead
  // Node exposes writeHeader as a separate alias, so override it too.
  Object.assign(response, { writeHeader: response.writeHead })
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
