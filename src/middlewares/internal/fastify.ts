import type { FastifyReply, FastifyRequest } from 'fastify'

import * as NodeRequest from './node.js'

/** Copies Fetch response headers to a Fastify reply. */
export function copyHeaders(reply: FastifyReply, headers: Headers): void {
  for (const [name, value] of headers) reply.header(name, value)
}

/** Sends a Fetch response through Fastify without changing its status, headers, or bytes. */
export async function sendResponse(reply: FastifyReply, response: Response) {
  copyHeaders(reply, response.headers)
  reply.code(response.status)
  if (response.body === null) return reply.send()
  return reply.send(Buffer.from(await response.arrayBuffer()))
}

/** Converts Fastify's parsed request into the Fetch request consumed by mppx core. */
export function toRequest(request: FastifyRequest): Request {
  return NodeRequest.toRequest({
    body: request.body,
    headers: request.headers,
    method: request.method,
    url: `${request.protocol}://${request.host}${request.url}`,
  })
}
