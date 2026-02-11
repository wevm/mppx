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

describe('applyAuth', () => {
  test('behavior: bearer sets Authorization header', () => {
    const request = new Request('https://example.com/api')
    const result = Headers.applyAuth(request, {
      type: 'bearer',
      token: 'my-token',
    })
    expect(result).toBeInstanceOf(Request)
    expect((result as Request).headers.get('authorization')).toBe('Bearer my-token')
  })

  test('behavior: basic sets Authorization with base64-encoded credentials', () => {
    const request = new Request('https://example.com/api')
    const result = Headers.applyAuth(request, {
      type: 'basic',
      username: 'user',
      password: 'pass',
    })
    expect(result).toBeInstanceOf(Request)
    expect((result as Request).headers.get('authorization')).toBe(`Basic ${btoa('user:pass')}`)
  })

  test('behavior: header sets custom header name/value', () => {
    const request = new Request('https://example.com/api')
    const result = Headers.applyAuth(request, {
      type: 'header',
      name: 'X-API-Key',
      value: 'key-123',
    })
    expect(result).toBeInstanceOf(Request)
    expect((result as Request).headers.get('x-api-key')).toBe('key-123')
  })

  test('behavior: query appends query parameter to URL', () => {
    const request = new Request('https://example.com/api')
    const result = Headers.applyAuth(request, {
      type: 'query',
      name: 'api_key',
      value: 'key-123',
    })
    expect(result).toBeInstanceOf(Request)
    const url = new URL((result as Request).url)
    expect(url.searchParams.get('api_key')).toBe('key-123')
  })

  test('behavior: custom calls the apply function', async () => {
    const request = new Request('https://example.com/api')
    const result = await Headers.applyAuth(request, {
      type: 'custom',
      apply: (req) => {
        const headers = new globalThis.Headers(req.headers)
        headers.set('X-Custom', 'applied')
        return new Request(req.url, { headers })
      },
    })
    expect(result.headers.get('x-custom')).toBe('applied')
  })

  test('behavior: preserves existing headers when applying auth', () => {
    const request = new Request('https://example.com/api', {
      headers: { 'Content-Type': 'application/json', Accept: '*/*' },
    })
    const result = Headers.applyAuth(request, {
      type: 'bearer',
      token: 'my-token',
    }) as Request
    expect(result.headers.get('content-type')).toBe('application/json')
    expect(result.headers.get('accept')).toBe('*/*')
    expect(result.headers.get('authorization')).toBe('Bearer my-token')
  })

  test('behavior: preserves request method and body for POST requests', async () => {
    const body = JSON.stringify({ key: 'value' })
    const request = new Request('https://example.com/api', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
    })
    const result = Headers.applyAuth(request, {
      type: 'bearer',
      token: 'my-token',
    }) as Request
    expect(result.method).toBe('POST')
    expect(await result.text()).toBe(body)
  })
})
