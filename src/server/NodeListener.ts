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
  if (isResponseClosed(res)) {
    await response.body?.cancel('response connection closed').catch(() => {})
    return
  }

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
    let connectionClosed = false
    const onClose = () => {
      connectionClosed = true
      void reader.cancel('response connection closed').catch(() => {})
    }
    res.once('close', onClose)
    if (isResponseClosed(res)) onClose()
    try {
      if (res.destroyed || res.writableEnded) {
        await reader.cancel('response connection closed')
        return
      }
      while (true) {
        const { done, value } = await reader.read()
        if (done || connectionClosed) break
        if ((res as http.ServerResponse).write(value) === false) {
          try {
            if (!(await waitForDrain(res))) {
              await reader.cancel('response connection closed')
              return
            }
          } catch (error) {
            await reader.cancel(error).catch(() => {})
            throw error
          }
        }
      }
    } finally {
      res.removeListener('close', onClose)
      reader.releaseLock()
    }
  }

  if (!isResponseClosed(res)) res.end()
}

/** Returns whether the HTTP/1 response or underlying HTTP/2 stream has closed. */
function isResponseClosed(res: http.ServerResponse | http2.Http2ServerResponse): boolean {
  const stream = 'stream' in res ? res.stream : undefined
  return Boolean(res.destroyed || res.writableEnded || stream?.destroyed || stream?.closed)
}

/**
 * Waits for write backpressure to clear.
 *
 * Returns `true` on drain, `false` when the response closes, and rejects on a
 * write-side error. Event listeners are always removed before settlement.
 */
function waitForDrain(res: http.ServerResponse | http2.Http2ServerResponse): Promise<boolean> {
  if (isResponseClosed(res)) return Promise.resolve(false)
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      res.removeListener('drain', onDrain)
      res.removeListener('close', onClose)
      res.removeListener('error', onError)
    }
    const onDrain = () => {
      cleanup()
      resolve(true)
    }
    const onClose = () => {
      cleanup()
      resolve(false)
    }
    const onError = (error: Error) => {
      cleanup()
      reject(error)
    }
    res.once('drain', onDrain)
    res.once('close', onClose)
    res.once('error', onError)
    if (isResponseClosed(res)) onClose()
  })
}
