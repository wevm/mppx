import { EventEmitter } from 'node:events'
import type { IncomingMessage, ServerResponse } from 'node:http'

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
      rawHeaders: ['Host', 'example.com', 'Content-Type', 'application/json'],
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
})
