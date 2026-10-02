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
  'payment-session',
  'payment-session-snapshot',
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
  for (const name of paymentHeaders) {
    if (name !== 'authorization' && name !== 'www-authenticate') headers.delete(name)
  }
  headers.delete('payment-authorization')
  const authorization = headers.get('authorization')
  if (authorization && /^\s*Payment(?:\s|$)/i.test(authorization)) headers.delete('authorization')
  const authenticate = headers.get('www-authenticate')
  if (authenticate) {
    const remaining = removePaymentChallenges(authenticate)
    if (remaining) headers.set('www-authenticate', remaining)
    else headers.delete('www-authenticate')
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/** Removes Payment authentication challenges while preserving other schemes. */
function removePaymentChallenges(value: string): string {
  const starts: { index: number; scheme: string }[] = []
  let inQuotes = false
  let escaped = false

  for (let index = 0; index < value.length; index++) {
    const character = value[index]!
    if (inQuotes) {
      if (escaped) escaped = false
      else if (character === '\\') escaped = true
      else if (character === '"') inQuotes = false
      continue
    }
    if (character === '"') {
      inQuotes = true
      continue
    }

    const previous = value.slice(0, index).trimEnd().at(-1)
    if (index !== 0 && previous !== ',') continue
    const match = value.slice(index).match(/^\s*([!#$%&'*+.^_`|~0-9A-Za-z-]+)(?=\s|,|$)/)
    if (!match) continue
    const start = index + match[0].length - match[0].trimStart().length
    const afterScheme = start + match[1]!.length
    let next = afterScheme
    while (/\s/.test(value[next] ?? '')) next++
    if (value[next] === '=') continue
    starts.push({ index: start, scheme: match[1]!.toLowerCase() })
    index = afterScheme - 1
  }

  return starts
    .filter(({ scheme }) => scheme !== 'payment')
    .map(({ index }) => {
      const originalPosition = starts.findIndex((start) => start.index === index)
      const end = starts[originalPosition + 1]?.index ?? value.length
      return value.slice(index, end).replace(/,\s*$/, '').trim()
    })
    .filter(Boolean)
    .join(', ')
}
