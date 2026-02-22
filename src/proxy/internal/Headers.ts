const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'transfer-encoding',
  'upgrade',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
])

/** Strips hop-by-hop, auth, encoding, cookie, and forwarding headers from a request before proxying upstream. */
export function scrub(headers: Headers): Headers {
  const scrubbed = new Headers()

  for (const [name, value] of headers) {
    const lower = name.toLowerCase()

    if (lower === 'authorization') continue
    if (lower === 'accept-encoding') continue
    if (lower === 'content-length') continue
    if (lower === 'cookie') continue
    if (hopByHopHeaders.has(lower)) continue
    if (lower.startsWith('x-forwarded-')) continue

    scrubbed.append(name, value)
  }

  return scrubbed
}

/** Strips `content-encoding` and `content-length` from an upstream response so the proxy can re-stream it. */
export function scrubResponse(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
