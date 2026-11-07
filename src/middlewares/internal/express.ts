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
  }
  // The transport must write to the socket without re-entering the app's gate.
  const output = new Proxy(response, {
    get(target, property) {
      if (Object.hasOwn(original, property)) return original[property as keyof typeof original]
      const value = Reflect.get(target, property, target)
      return typeof value === 'function' ? value.bind(target) : value
    },
  })
  let started = false
  body.on('drain', () => response.emit('drain'))
  body.on('error', () => {})
  response.once('close', () => body.destroy())

  function start() {
    if (started) return
    started = true
    const headers = new Headers()
    for (const [name, value] of Object.entries(response.getHeaders())) {
      if (Array.isArray(value)) for (const item of value) headers.append(name, item)
      else if (value !== undefined) headers.set(name, String(value))
    }
    const hasBody = ![204, 205, 304].includes(response.statusCode)
    const stream = Readable.toWeb(body) as ReadableStream<Uint8Array>
    if (!hasBody) body.resume()
    void Promise.resolve()
      .then(() =>
        withReceipt(
          new Response(hasBody ? stream : null, {
            headers,
            status: response.statusCode,
            statusText: response.statusMessage,
          }),
        ),
      )
      .then(async (wrapped) => {
        // The payment transport may replace the body and remove content-length.
        for (const name of response.getHeaderNames()) response.removeHeader(name)
        await NodeListener.sendResponse(output, wrapped)
      })
      .catch((error) => {
        body.destroy()
        Object.assign(response, original)
        if (response.headersSent) response.destroy()
        else onError(error)
      })
  }

  response.write = ((...args: Parameters<typeof body.write>) => {
    start()
    return body.write(...args)
  }) as typeof response.write
  response.end = ((...args: Parameters<typeof body.end>) => {
    start()
    body.end(...args)
    return response
  }) as typeof response.end
  response.writeHead = ((status: number, messageOrHeaders?: string | object, headers?: object) => {
    response.statusCode = status
    if (typeof messageOrHeaders === 'string') response.statusMessage = messageOrHeaders
    const values = typeof messageOrHeaders === 'string' ? headers : messageOrHeaders
    if (Array.isArray(values)) {
      for (let i = 0; i < values.length; i += 2) response.setHeader(values[i], values[i + 1])
    } else if (values) {
      for (const [name, value] of Object.entries(values)) response.setHeader(name, value)
    }
    start()
    return response
  }) as typeof response.writeHead
  response.flushHeaders = start
}
