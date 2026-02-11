import type { IncomingMessage, RequestListener, ServerResponse } from 'node:http'
import * as FetchServer from '@remix-run/node-fetch-server'

export type FetchHandler = (request: Request) => Promise<Response> | Response

/**
 * Converts a Fetch API handler into a Node.js HTTP request listener.
 *
 * Uses [`@remix-run/node-fetch-server`](https://github.com/remix-run/remix/blob/main/packages/node-fetch-server/src/lib/request-listener.ts).
 *
 * @param handler - A Fetch API handler: `(request: Request) => Response`.
 * @param options - Optional error handler.
 * @returns A Node.js `(req, res)` listener.
 */
export function toNodeListener(
  handler: FetchHandler,
  options?: FetchServer.RequestListenerOptions | undefined,
): RequestListener {
  return FetchServer.createRequestListener(handler, options) as never
}

/**
 * Converts a Node.js `IncomingMessage`/`ServerResponse` pair to a Fetch API `Request`.
 *
 * Uses [`@remix-run/node-fetch-server`](https://github.com/remix-run/remix/blob/main/packages/node-fetch-server/src/lib/request-listener.ts).
 *
 * @param req - The Node.js IncomingMessage.
 * @param res - The Node.js ServerResponse (used for abort signal lifecycle).
 * @returns A Fetch API Request.
 */
export function fromNodeListener(req: IncomingMessage, res: ServerResponse): Request {
  return FetchServer.createRequest(req, res)
}
