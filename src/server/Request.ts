import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'

import * as NodeListener from './NodeListener.js'

export type FetchHandler = (request: Request) => Promise<Response> | Response

export type RequestListenerOptions = {
  host?: string | undefined
  onError?: ((error: unknown) => void | Response | Promise<void | Response>) | undefined
  protocol?: string | undefined
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
      console.error(error)
      return new Response('Internal Server Error', {
        status: 500,
        headers: { 'Content-Type': 'text/plain' },
      })
    })

  return (async (req: IncomingMessage, res: ServerResponse) => {
    const request = fromNodeListener(req, res, options)
    let response: Response
    try {
      response = await handler(request)
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
  options?: RequestListenerOptions | undefined,
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
  const url = new URL(normalizeRequestTarget(req.url), `${protocol}//${host}`)

  const init: RequestInit & { duplex?: string } = {
    method,
    headers,
    signal: controller.signal,
  }

  if (method !== 'GET' && method !== 'HEAD') {
    init.body = new ReadableStream({
      start(c) {
        req.on('data', (chunk: Buffer) => {
          c.enqueue(new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength))
        })
        req.on('end', () => {
          c.close()
        })
      },
    })
    init.duplex = 'half'
  }

  return new Request(url, init)
}

function normalizeRequestTarget(url: string | undefined): string {
  if (!url) return '/'

  try {
    const absoluteUrl = new URL(url)
    // Absolute-form request targets can carry a different origin than the socket host.
    // Keep only path+query so realm detection stays bound to Host/:authority.
    if (absoluteUrl.protocol === 'http:' || absoluteUrl.protocol === 'https:')
      return `${absoluteUrl.pathname}${absoluteUrl.search}`
  } catch {}

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
