import * as FetchServer from '@remix-run/node-fetch-server'

/**
 * Writes a Fetch API `Response` to a Node.js `ServerResponse`.
 *
 * Delegates to `@remix-run/node-fetch-server`. Useful when bridging
 * Fetch API handlers with Node.js HTTP servers.
 */
export const sendResponse = FetchServer.sendResponse
