import { EventEmitter } from 'node:events'
import type { IncomingMessage } from 'node:http'
import { Request } from 'mpay/server'
import { describe, expect, test } from 'vitest'

function createMockRequest(options: {
  method?: string
  url?: string
  rawHeaders?: string[]
  socket?: { encrypted?: boolean }
}): IncomingMessage {
  const emitter = new EventEmitter()
  return Object.assign(emitter, {
    method: options.method ?? 'GET',
    url: options.url ?? '/',
    rawHeaders: options.rawHeaders ?? [],
    socket: options.socket ?? {},
  }) as unknown as IncomingMessage
}

describe('fromNodeRequest', () => {
  test('converts IncomingMessage to Fetch Request', () => {
    const incoming = createMockRequest({
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

    const request = Request.fromNodeListener(incoming)

    expect(request.method).toBe('POST')
    expect(request.url).toBe('http://example.com/api/resource')
    expect(request.headers.get('Authorization')).toBe('Bearer token')
    expect(request.headers.get('Content-Type')).toBe('application/json')
  })

  test('uses default values when host/url/method missing', () => {
    const incoming = createMockRequest({})

    const request = Request.fromNodeListener(incoming)

    expect(request.method).toBe('GET')
    expect(request.url).toBe('http://localhost/')
  })

  test('preserves multi-value headers via append', () => {
    const incoming = createMockRequest({
      rawHeaders: ['Host', 'example.com', 'Set-Cookie', 'a=1', 'Set-Cookie', 'b=2'],
    })

    const request = Request.fromNodeListener(incoming)

    expect(request.headers.get('Set-Cookie')).toBe('a=1, b=2')
  })

  test('skips HTTP/2 pseudo-headers', () => {
    const incoming = createMockRequest({
      rawHeaders: [':method', 'GET', ':path', '/', 'Host', 'example.com'],
    })

    const request = Request.fromNodeListener(incoming)

    expect([...request.headers.keys()]).toEqual(['host'])
    expect(request.headers.get('Host')).toBe('example.com')
  })

  test('streams body for POST requests', async () => {
    const incoming = createMockRequest({
      method: 'POST',
      rawHeaders: ['Host', 'example.com', 'Content-Type', 'application/json'],
    })

    const request = Request.fromNodeListener(incoming)

    setImmediate(() => {
      incoming.emit('data', Buffer.from('{"hello":'))
      incoming.emit('data', Buffer.from('"world"}'))
      incoming.emit('end')
    })

    const body = await request.text()
    expect(body).toBe('{"hello":"world"}')
  })
})
