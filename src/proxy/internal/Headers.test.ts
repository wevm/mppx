import { describe, expect, test } from 'vitest'

import * as Headers from './Headers.js'

describe('scrub', () => {
  test('behavior: strips authorization header', () => {
    const headers = new globalThis.Headers({
      Authorization: 'Bearer secret',
      'Content-Type': 'application/json',
    })
    const result = Headers.scrub(headers)
    expect(result.has('authorization')).toBe(false)
    expect(result.get('content-type')).toBe('application/json')
  })

  test('behavior: strips cookie header', () => {
    const headers = new globalThis.Headers({
      Cookie: 'session=abc123',
      Accept: 'text/html',
    })
    const result = Headers.scrub(headers)
    expect(result.has('cookie')).toBe(false)
    expect(result.get('accept')).toBe('text/html')
  })

  test('behavior: strips hop-by-hop headers', () => {
    const headers = new globalThis.Headers({
      Connection: 'keep-alive',
      'Keep-Alive': 'timeout=5',
      'Transfer-Encoding': 'chunked',
      Upgrade: 'websocket',
      'Proxy-Authenticate': 'Basic',
      'Proxy-Authorization': 'Basic abc',
      TE: 'trailers',
      Trailer: 'Expires',
      'Content-Type': 'application/json',
    })
    const result = Headers.scrub(headers)
    expect(result.has('connection')).toBe(false)
    expect(result.has('keep-alive')).toBe(false)
    expect(result.has('transfer-encoding')).toBe(false)
    expect(result.has('upgrade')).toBe(false)
    expect(result.has('proxy-authenticate')).toBe(false)
    expect(result.has('proxy-authorization')).toBe(false)
    expect(result.has('te')).toBe(false)
    expect(result.has('trailer')).toBe(false)
    expect(result.get('content-type')).toBe('application/json')
  })

  test('behavior: strips x-forwarded-* headers', () => {
    const headers = new globalThis.Headers({
      'X-Forwarded-For': '127.0.0.1',
      'X-Forwarded-Proto': 'https',
      'X-Forwarded-Host': 'example.com',
      Accept: '*/*',
    })
    const result = Headers.scrub(headers)
    expect(result.has('x-forwarded-for')).toBe(false)
    expect(result.has('x-forwarded-proto')).toBe(false)
    expect(result.has('x-forwarded-host')).toBe(false)
    expect(result.get('accept')).toBe('*/*')
  })

  test('behavior: preserves safe headers', () => {
    const headers = new globalThis.Headers({
      'Content-Type': 'application/json',
      Accept: 'text/html',
      'User-Agent': 'test-agent/1.0',
      'X-Custom-Header': 'value',
    })
    const result = Headers.scrub(headers)
    expect(result.get('content-type')).toBe('application/json')
    expect(result.get('accept')).toBe('text/html')
    expect(result.get('user-agent')).toBe('test-agent/1.0')
    expect(result.get('x-custom-header')).toBe('value')
  })
})

describe('scrubResponse', () => {
  test('behavior: strips content-encoding and content-length', () => {
    const response = new Response('body', {
      headers: {
        'Content-Encoding': 'gzip',
        'Content-Length': '42',
        'Content-Type': 'application/json',
      },
    })
    const result = Headers.scrubResponse(response)
    expect(result.headers.has('content-encoding')).toBe(false)
    expect(result.headers.has('content-length')).toBe(false)
    expect(result.headers.get('content-type')).toBe('application/json')
  })

  test('behavior: preserves status and body', async () => {
    const response = new Response('hello', { status: 201, statusText: 'Created' })
    const result = Headers.scrubResponse(response)
    expect(result.status).toBe(201)
    expect(result.statusText).toBe('Created')
    expect(await result.text()).toBe('hello')
  })
})
