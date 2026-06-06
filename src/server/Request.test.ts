import { EventEmitter } from 'node:events'
import { createServer } from 'node:http'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { connect } from 'node:net'

import { Request } from 'mppx/server'
import { describe, expect, test } from 'vp/test'

function createMockRequest(options: {
  method?: string
  url?: string
  rawHeaders?: string[]
  socket?: { encrypted?: boolean }
}): [IncomingMessage, ServerResponse] {
  const rawHeaders = options.rawHeaders ?? []
  const headers = Object.fromEntries(
    rawHeaders.reduce<[string, string][]>((acc, v, i, arr) => {
      if (i % 2 === 0 && arr[i + 1]) acc.push([v.toLowerCase(), arr[i + 1]!])
      return acc
    }, []),
  )
  const req = Object.assign(new EventEmitter(), {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    headers,
    rawHeaders,
    socket: options.socket ?? {},
  }) as unknown as IncomingMessage

  const res = new EventEmitter() as unknown as ServerResponse

  return [req, res]
}

describe('fromNodeListener', () => {
  test('converts IncomingMessage to Fetch Request', () => {
    const [req, res] = createMockRequest({
      method: 'POST',
      url: '/api/resource',
      rawHeaders: [
        'Host',
        'example.com',
        'Authorization',
        'Bearer token',
        'Content-Type',
        'application/json',
      ],
    })

    const request = Request.fromNodeListener(req, res)

    expect(request.method).toBe('POST')
    expect(request.url).toBe('http://example.com/api/resource')
    expect(request.headers.get('Authorization')).toBe('Bearer token')
    expect(request.headers.get('Content-Type')).toBe('application/json')
  })

  test('uses default values when host/url/method missing', () => {
    const [req, res] = createMockRequest({})

    const request = Request.fromNodeListener(req, res)

    expect(request.method).toBe('GET')
    expect(request.url).toBe('http://localhost/')
  })

  test('normalizes absolute-form request targets to the host header', () => {
    const [req, res] = createMockRequest({
      url: 'http://unexpected.example/api/resource?q=1',
      rawHeaders: ['Host', 'example.com'],
    })

    const request = Request.fromNodeListener(req, res)

    expect(request.url).toBe('http://example.com/api/resource?q=1')
  })

  // The request target's authority must never override the trusted host
  // (options.host > Host > :authority > localhost). A raw request line can
  // carry protocol-relative, triple-slash, backslash, or embedded-authority
  // targets that WHATWG URL would otherwise resolve into a foreign host.
  test.each([
    ['protocol-relative', '//evil.com/path?q=1', 'http://example.com/path?q=1'],
    ['triple-slash', '///evil.com/x', 'http://example.com/x'],
    ['backslash', '/\\evil.com/x', 'http://example.com/x'],
    ['userinfo authority', '//user:pass@evil.com/path', 'http://example.com/path'],
    ['ipv6 authority', '//[2001:db8::1]:8443/path', 'http://example.com/path'],
    ['embedded authority', '//first.example//evil.com/path', 'http://example.com//evil.com/path'],
    [
      'absolute embedded authority',
      'http://first.example//evil.com/p',
      'http://example.com//evil.com/p',
    ],
    ['encoded slashes stay path', '/%2F%2Fevil.com/p', 'http://example.com/%2F%2Fevil.com/p'],
  ])('binds host to Host header for %s request targets', (_name, url, expected) => {
    const [req, res] = createMockRequest({ url, rawHeaders: ['Host', 'example.com'] })

    const request = Request.fromNodeListener(req, res)

    expect(request.url).toBe(expected)
    expect(new URL(request.url).host).toBe('example.com')
  })

  test('uses explicit protocol and host overrides', () => {
    const [req, res] = createMockRequest({
      url: '/api/resource',
      rawHeaders: ['Host', 'internal.local'],
      socket: { encrypted: false },
    })

    const request = Request.fromNodeListener(req, res, {
      host: 'api.example.com',
      protocol: 'https:',
    })

    expect(request.url).toBe('https://api.example.com/api/resource')
  })

  test('preserves multi-value headers via append', () => {
    const [req, res] = createMockRequest({
      rawHeaders: ['Host', 'example.com', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2'],
    })

    const request = Request.fromNodeListener(req, res)

    expect(request.headers.get('Set-Cookie')).toBe('a=1, b=2')
  })

  test('skips HTTP/2 pseudo-headers', () => {
    const [req, res] = createMockRequest({
      rawHeaders: [':method', 'GET', ':path', '/', 'Host', 'example.com'],
    })

    const request = Request.fromNodeListener(req, res)

    expect([...request.headers.keys()]).toEqual(['host'])
    expect(request.headers.get('Host')).toBe('example.com')
  })

  test('streams body for POST requests', async () => {
    const [req, res] = createMockRequest({
      method: 'POST',
      rawHeaders: [
        'Host',
        'example.com',
        'Content-Length',
        '17',
        'Content-Type',
        'application/json',
      ],
    })

    const request = Request.fromNodeListener(req, res)

    setImmediate(() => {
      req.emit('data', Buffer.from('{"hello":'))
      req.emit('data', Buffer.from('"world"}'))
      req.emit('end')
    })

    const body = await request.text()
    expect(body).toBe('{"hello":"world"}')
  })

  test('does not attach a body stream for empty POST requests', () => {
    const [req, res] = createMockRequest({
      method: 'POST',
      rawHeaders: ['Host', 'example.com'],
    })

    const request = Request.fromNodeListener(req, res)

    expect(request.body).toBeNull()
  })

  test('does not attach a body stream for content-length: 0', () => {
    const [req, res] = createMockRequest({
      method: 'POST',
      rawHeaders: ['Host', 'example.com', 'Content-Length', '0'],
    })

    const request = Request.fromNodeListener(req, res)

    expect(request.body).toBeNull()
  })

  test('attaches a body stream for chunked POST requests', async () => {
    const [req, res] = createMockRequest({
      method: 'POST',
      rawHeaders: ['Host', 'example.com', 'Transfer-Encoding', 'chunked'],
    })

    const request = Request.fromNodeListener(req, res)

    setImmediate(() => {
      req.emit('data', Buffer.from('hello'))
      req.emit('end')
    })

    expect(await request.text()).toBe('hello')
  })
})

// Conformance harness: a normal HTTP client cannot emit these request targets,
// so they are driven through Node's real HTTP parser over a raw socket to prove
// the adapter neutralizes host confusion end-to-end (not just via mocks).
describe('toNodeListener (raw request target)', () => {
  async function captureRequestUrl(rawRequestLine: string): Promise<string> {
    let resolveUrl!: (url: string) => void
    const observed = new Promise<string>((resolve) => {
      resolveUrl = resolve
    })

    const server = createServer(
      Request.toNodeListener(async (request) => {
        resolveUrl(request.url)
        return new Response('ok')
      }),
    )

    try {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
      const { port } = server.address() as AddressInfo
      const socket = connect(port, '127.0.0.1')
      await new Promise<void>((resolve, reject) => {
        socket.once('connect', () => resolve())
        socket.once('error', reject)
      })
      socket.write(rawRequestLine)
      const url = await observed
      socket.destroy()
      return url
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
  }

  test('binds host to Host header for a protocol-relative raw request target', async () => {
    const url = await captureRequestUrl(
      'GET //evil.com/protected?q=1 HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n',
    )

    expect(url).toBe('http://example.com/protected?q=1')
    expect(new URL(url).host).toBe('example.com')
  })

  test('binds host to Host header for an embedded-authority raw request target', async () => {
    const url = await captureRequestUrl(
      'GET //first.example//evil.com/protected HTTP/1.1\r\nHost: example.com\r\nConnection: close\r\n\r\n',
    )

    expect(new URL(url).host).toBe('example.com')
  })
})
