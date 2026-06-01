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

// Payment credentials are consumed by the proxy and must never reach upstream services.
const paymentHeaders = new Set([
  'accept-payment',
  'authorization',
  'payment-receipt',
  'payment-required',
  'payment-response',
  'payment-signature',
  'www-authenticate',
])

/** Strips hop-by-hop, auth, encoding, cookie, and forwarding headers from a request before proxying upstream. */
export function scrub(headers: Headers): Headers {
  const scrubbed = new Headers()

  for (const [name, value] of headers) {
    const lower = name.toLowerCase()

    if (paymentHeaders.has(lower)) continue
    if (lower === 'accept-encoding') continue
    if (lower === 'content-length') continue
    if (lower === 'cookie') continue
    if (hopByHopHeaders.has(lower)) continue
    if (lower.startsWith('x-forwarded-')) continue

    scrubbed.append(name, value)
  }

  return scrubbed
}

/**
 * Strips re-streaming headers (`content-encoding`, `content-length`) and
 * security-sensitive headers (`set-cookie`) from an upstream response.
 *
 * `set-cookie` is dropped because a paid API proxy must never let an upstream
 * service set cookies in the user's browser under the proxy's origin. If a
 * compromised, misbehaving, or attacker-influenced upstream returned
 * `Set-Cookie: session=evil; Domain=.example.com`, the browser would honor it
 * for every sibling subdomain of the proxy — turning any future path-confusion
 * or open-redirect bug in the surrounding deployment into a session-fixation
 * primitive. Proxied services authenticate via bearer tokens / signed
 * payloads, never cookies, so dropping `set-cookie` is purely defensive.
 */
export function scrubResponse(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.delete('content-encoding')
  headers.delete('content-length')
  headers.delete('set-cookie')
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}
