import type { Request as ExpressRequest, Response as ExpressResponse } from 'express'

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

export class InvalidRequestTargetError extends Error {}

/** Converts an Express parsed request into the Fetch request consumed by mppx core. */
export function toRequest(request: ExpressRequest, protocol = request.protocol): Request {
  const url = new URL(`${protocol}://${request.get('host')}`)
  let target: URL
  try {
    target = new URL(
      request.originalUrl.startsWith('/')
        ? `http://mppx.invalid${request.originalUrl}`
        : request.originalUrl,
      'http://mppx.invalid',
    )
  } catch {
    throw new InvalidRequestTargetError('Invalid request target')
  }
  if (target.protocol !== 'http:' && target.protocol !== 'https:')
    throw new InvalidRequestTargetError('Unsupported request target protocol')
  url.pathname = target.pathname
  url.search = target.search
  return NodeRequest.toRequest({
    body: request.body,
    headers: request.headers,
    method: request.method,
    url: url.href,
  })
}
