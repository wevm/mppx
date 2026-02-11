import type { Auth } from '../Service.js'

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

export function scrub(headers: Headers): Headers {
  const scrubbed = new Headers()

  for (const [name, value] of headers) {
    const lower = name.toLowerCase()

    if (lower === 'authorization') continue
    if (lower === 'accept-encoding') continue
    if (lower === 'cookie') continue
    if (hopByHopHeaders.has(lower)) continue
    if (lower.startsWith('x-forwarded-')) continue

    scrubbed.append(name, value)
  }

  return scrubbed
}

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

export function applyAuth(request: Request, auth: Auth): Request | Promise<Request> {
  switch (auth.type) {
    case 'bearer': {
      request.headers.set('Authorization', `Bearer ${auth.token}`)
      return request
    }

    case 'basic': {
      const encoded = btoa(`${auth.username}:${auth.password}`)
      request.headers.set('Authorization', `Basic ${encoded}`)
      return request
    }

    case 'header': {
      request.headers.set(auth.name, auth.value)
      return request
    }

    case 'query': {
      const url = new URL(request.url)
      url.searchParams.set(auth.name, auth.value)
      return new Request(url, {
        method: request.method,
        headers: request.headers,
        signal: request.signal,
      })
    }

    case 'custom':
      return auth.apply(request)
  }
}
