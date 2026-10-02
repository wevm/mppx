import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'

import * as NodeListener from './NodeListener.js'

export type FetchHandler = (request: Request) => Promise<Response> | Response

export type RequestListenerOptions = {
  host?: string | undefined
  /** Maximum accepted request body size in bytes. @default 10485760 (10 MiB) */
  maxBodySize?: number | undefined
  onError?: ((error: unknown) => void | Response | Promise<void | Response>) | undefined
  protocol?: string | undefined
}

/** Options used only while converting a Node request to a Fetch request. */
export type NodeConversionOptions = Omit<RequestListenerOptions, 'onError'>

const defaultMaxBodySize = 10 * 1024 * 1024
const bodyCompletions = new WeakMap<Request, Promise<unknown>>()

/** Raised when a Node request body exceeds the configured byte limit. */
export class RequestBodyTooLargeError extends Error {
  override readonly name = 'RequestBodyTooLargeError'
}

/**
 * Converts a Fetch API handler into a Node.js HTTP request listener.
 *
 * @param handler - A Fetch API handler: `(request: Request) => Response`.
 * @param options - Optional error handler.
 * @returns A Node.js `(req, res)` listener.
 */
export function toNodeListener(
  handler: FetchHandler,
  options?: RequestListenerOptions | undefined,
): RequestListener {
  const onError =
    options?.onError ??
    ((error: unknown) => {
      if (error instanceof RequestBodyTooLargeError)
        return new Response('Payload Too Large', {
          status: 413,
          headers: { 'Content-Type': 'text/plain' },
        })
      console.error(error)
      return new Response('Internal Server Error', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      })
    })

  return (async (req: IncomingMessage, res: ServerResponse) => {
    let response: Response
    try {
      const request = fromNodeListener(req, res, options)
      response = await handler(request)
      await waitForBody(request)
    } catch (error) {
      try {
        response =
          (await onError(error)) ??
          new Response('Internal Server Error', {
            status: 500,
            headers: { 'Content-Type': 'text/plain' },
          })
      } catch (innerError) {
        console.error(`There was an error in the error handler: ${innerError}`)
        response = new Response('Internal Server Error', {
          status: 500,
          headers: { 'Content-Type': 'text/plain' },
        })
      }
    }
    await NodeListener.sendResponse(res, response)
  }) as RequestListener
}

/**
 * Converts a Node.js `IncomingMessage`/`ServerResponse` pair to a Fetch API `Request`.
 *
 * @param req - The Node.js IncomingMessage.
 * @param res - The Node.js ServerResponse (used for abort signal lifecycle).
 * @returns A Fetch API Request.
 */
export function fromNodeListener(
  req: IncomingMessage,
  res: ServerResponse,
  options?: NodeConversionOptions | undefined,
): Request {
  let controller: AbortController | null = new AbortController()
  res.once('close', () => controller?.abort())
  res.once('finish', () => {
    controller = null
  })

  const method = req.method ?? 'GET'
  const headers = createHeaders(req)
  const protocol =
    options?.protocol ??
    ('encrypted' in req.socket && (req.socket as { encrypted?: boolean }).encrypted
      ? 'https:'
      : 'http:')
  const host =
    options?.host ??
    headers.get('Host') ??
    (req.headers as Record<string, string>)[':authority'] ??
    'localhost'
  const url = createRequestUrl(req.url, `${protocol}//${host}`)

  const init: RequestInit & { duplex?: string } = {
    method,
    headers,
    signal: controller.signal,
  }

  const maxBodySize = options?.maxBodySize ?? defaultMaxBodySize
  validateBodySize(req, maxBodySize)
  let bodyCompletion: Promise<unknown> | undefined
  let body: ReadableStream<Uint8Array> | undefined
  if (hasBody(headers)) {
    const monitored = createBodyStream(req, maxBodySize)
    body = monitored.body
    if (method !== 'GET' && method !== 'HEAD') {
      init.body = body
      init.duplex = 'half'
      bodyCompletion = monitored.completion
    } else {
      void consumeBody(body).catch(() => {})
      bodyCompletion = monitored.completion
    }
  }

  let request: Request
  try {
    request = new Request(url, init)
  } catch (error) {
    void body?.cancel(error).catch(() => {})
    throw error
  }
  if (bodyCompletion) bodyCompletions.set(request, bodyCompletion)
  return request
}

/** Waits for a Node-backed request body to finish and enforces its size limit. */
export async function waitForBody(request: Request): Promise<void> {
  const completion = bodyCompletions.get(request)
  if (!completion) return
  if (request.body && !request.bodyUsed && !request.body.locked) await consumeBody(request.body)
  const error = await completion
  if (error !== undefined) throw error
}

async function consumeBody(body: ReadableStream<Uint8Array>): Promise<void> {
  const reader = body.getReader()
  try {
    while (!(await reader.read()).done) {}
  } finally {
    reader.releaseLock()
  }
}

function createBodyStream(
  req: IncomingMessage,
  maxBodySize: number,
): { body: ReadableStream<Uint8Array>; completion: Promise<unknown> } {
  let received = 0
  let closed = false
  let cleanup = () => {}
  let resolveCompletion!: (error?: unknown) => void
  const completion = new Promise<unknown>((resolve) => {
    resolveCompletion = resolve
  })

  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const finish = (action: () => void, error?: unknown) => {
        if (closed) return
        closed = true
        cleanup()
        action()
        resolveCompletion(error)
      }
      const onData = (value: Buffer | string) => {
        const chunk = typeof value === 'string' ? Buffer.from(value) : value
        received += chunk.byteLength
        if (received > maxBodySize) {
          const error = new RequestBodyTooLargeError(`Request body exceeds ${maxBodySize} bytes`)
          finish(() => controller.error(error), error)
          req.resume()
          return
        }
        controller.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
        if ((controller.desiredSize ?? 0) <= 0) req.pause()
      }
      const onEnd = () => finish(() => controller.close())
      const onError = (error: Error) => finish(() => controller.error(error), error)
      const onAborted = () => {
        const error = new Error('request aborted')
        finish(() => controller.error(error), error)
      }
      cleanup = () => {
        req.removeListener('data', onData)
        req.removeListener('end', onEnd)
        req.removeListener('error', onError)
        req.removeListener('aborted', onAborted)
      }
      req.pause()
      req.on('data', onData)
      req.once('end', onEnd)
      req.once('error', onError)
      req.once('aborted', onAborted)
    },
    pull() {
      if (!closed) req.resume()
    },
    cancel(reason) {
      if (closed) return
      closed = true
      cleanup()
      req.destroy(reason instanceof Error ? reason : undefined)
      resolveCompletion(reason)
    },
  })
  return { body, completion }
}

function validateBodySize(req: IncomingMessage, maxBodySize: number): void {
  if (!Number.isSafeInteger(maxBodySize) || maxBodySize < 0)
    throw new TypeError('maxBodySize must be a non-negative safe integer')

  const contentLength = Number(req.headers['content-length'])
  if (Number.isFinite(contentLength) && contentLength > maxBodySize) {
    req.resume()
    throw new RequestBodyTooLargeError(`Request body exceeds ${maxBodySize} bytes`)
  }
}

function hasBody(headers: Headers): boolean {
  const contentLength = headers.get('content-length')
  return (contentLength !== null && contentLength !== '0') || headers.has('transfer-encoding')
}

/**
 * Builds the request `URL` from a request target and a trusted origin.
 *
 * Only the parsed `pathname`/`search` are copied onto the trusted origin, so
 * the target's authority can never override the host (protocol-relative,
 * `///`, backslash, absolute-form, or embedded-authority targets). Components
 * are copied onto a `URL` object rather than concatenated and re-parsed, since
 * a normalized path can itself begin with `//` and be read as an authority.
 */
function createRequestUrl(target: string | undefined, origin: string): URL {
  const url = new URL(origin)
  if (!target) return url

  let parsed: URL
  try {
    parsed = new URL(target, 'http://mppx.invalid')
  } catch {
    throw new TypeError('Invalid request target')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:')
    throw new TypeError('Unsupported request target protocol')

  url.pathname = parsed.pathname
  url.search = parsed.search
  url.hash = ''
  return url
}

function createHeaders(req: IncomingMessage): Headers {
  const headers = new Headers()
  const raw = req.rawHeaders
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i]!.startsWith(':')) continue
    headers.append(raw[i]!, raw[i + 1]!)
  }
  return headers
}
