import { describe, expect, test } from 'vitest'
import * as Service from './Service.js'

describe('from', () => {
  test('behavior: creates service with id and baseUrl', () => {
    const service = Service.from('api', {
      baseUrl: 'https://api.example.com',
      routes: { 'GET /v1/status': true },
    })
    expect(service.id).toBe('api')
    expect(service.baseUrl).toBe('https://api.example.com')
  })

  test('behavior: resolves bearer auth', () => {
    const service = Service.from('api', {
      baseUrl: 'https://api.example.com',
      bearer: 'sk-123',
      routes: { 'GET /v1/data': true },
    })
    const auth = service.auth(true)
    expect(auth).toEqual({ type: 'bearer', token: 'sk-123' })
  })

  test('behavior: resolves single header auth', () => {
    const service = Service.from('api', {
      baseUrl: 'https://api.example.com',
      headers: { 'X-Api-Key': 'secret' },
      routes: { 'GET /v1/data': true },
    })
    const auth = service.auth(true)
    expect(auth).toEqual({ type: 'header', name: 'X-Api-Key', value: 'secret' })
  })

  test('behavior: resolves multiple headers as custom auth', async () => {
    const service = Service.from('api', {
      baseUrl: 'https://api.example.com',
      headers: { 'X-Key': 'a', 'X-Secret': 'b' },
      routes: { 'GET /v1/data': true },
    })
    const auth = service.auth(true)
    expect(auth.type).toBe('custom')

    if (auth.type !== 'custom') throw new Error()
    const req = new Request('https://example.com')
    const result = await auth.apply(req)
    expect(result.headers.get('X-Key')).toBe('a')
    expect(result.headers.get('X-Secret')).toBe('b')
  })

  test('behavior: resolves mutate auth', () => {
    const mutate = (req: Request) => req
    const service = Service.from('api', {
      baseUrl: 'https://api.example.com',
      mutate,
      routes: { 'GET /v1/data': true },
    })
    const auth = service.auth(true)
    expect(auth).toEqual({ type: 'custom', apply: mutate })
  })

  test('behavior: mutate takes priority over bearer', () => {
    const mutate = (req: Request) => req
    const service = Service.from('api', {
      baseUrl: 'https://api.example.com',
      mutate,
      bearer: 'sk-123',
      routes: { 'GET /v1/data': true },
    })
    const auth = service.auth(true)
    expect(auth.type).toBe('custom')
  })

  test('behavior: no-op auth when no config', async () => {
    const service = Service.from('api', {
      baseUrl: 'https://api.example.com',
      routes: { 'GET /v1/data': true },
    })
    const auth = service.auth(true)
    expect(auth.type).toBe('custom')

    if (auth.type !== 'custom') throw new Error()
    const req = new Request('https://example.com')
    const result = await auth.apply(req)
    expect(result).toBe(req)
  })

  test('behavior: per-endpoint options override service auth', () => {
    const handler: Service.IntentHandler = async () => ({
      status: 200 as const,
      withReceipt: <T>(r: T) => r,
    })
    const service = Service.from('api', {
      baseUrl: 'https://api.example.com',
      bearer: 'sk-default',
      routes: {
        'GET /v1/data': {
          pay: handler,
          options: { bearer: 'sk-override' },
        },
      },
    })
    const endpoint = service.routes['GET /v1/data']!
    const auth = service.auth(endpoint)
    expect(auth).toEqual({ type: 'bearer', token: 'sk-override' })
  })
})

describe('custom', () => {
  test('behavior: alias for from', () => {
    expect(Service.custom).toBe(Service.from)
  })
})

describe('getOptions', () => {
  test('behavior: returns options from endpoint object', () => {
    const handler: Service.IntentHandler = async () => ({
      status: 200 as const,
      withReceipt: <T>(r: T) => r,
    })
    const endpoint: Service.Endpoint = { pay: handler, options: { apiKey: 'sk-123' } }
    expect(Service.getOptions(endpoint)).toEqual({ apiKey: 'sk-123' })
  })

  test('behavior: returns undefined for function endpoint', () => {
    const handler: Service.IntentHandler = async () => ({
      status: 200 as const,
      withReceipt: <T>(r: T) => r,
    })
    expect(Service.getOptions(handler)).toBeUndefined()
  })

  test('behavior: returns undefined for true endpoint', () => {
    expect(Service.getOptions(true)).toBeUndefined()
  })
})
