import type * as http from 'node:http'
import type * as http2 from 'node:http2'

/**
 * Writes a Fetch API `Response` to a Node.js `ServerResponse`.
 *
 * Useful when bridging Fetch API handlers with Node.js HTTP servers.
 */
export async function sendResponse(
  res: http.ServerResponse | http2.Http2ServerResponse,
  response: Response,
): Promise<void> {
  const headers: Record<string, string | string[]> = {}
  for (const [key, value] of response.headers) {
    if (key in headers) {
      const existing = headers[key]
      if (Array.isArray(existing)) existing.push(value)
      else headers[key] = [existing!, value]
    } else {
      headers[key] = value
    }
  }

  if ('req' in res && (res as http.ServerResponse).req?.httpVersionMajor === 1)
    (res as http.ServerResponse).writeHead(response.status, response.statusText, headers)
  else (res as http2.Http2ServerResponse).writeHead(response.status, headers)

  if (response.body != null && (res as http.ServerResponse).req?.method !== 'HEAD') {
    const reader = response.body.getReader()
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        if ((res as http.ServerResponse).write(value) === false)
          await new Promise<void>((resolve) => {
            res.once('drain', resolve)
          })
      }
    } finally {
      reader.releaseLock()
    }
  }

  res.end()
}
