import { describe, expect, test } from 'vp/test'

import * as Route from './Route.js'

describe('pathname', () => {
  test('behavior: returns pathname without basePath', () => {
    expect(
      Route.pathname(new URL('http://localhost/api/proxy/openai/v1/models'), '/api/proxy'),
    ).toBe('/openai/v1/models')
  })

  test('behavior: handles basePath with trailing slash', () => {
    expect(
      Route.pathname(new URL('http://localhost/api/proxy/stripe/v1/charges'), '/api/proxy/'),
    ).toBe('/stripe/v1/charges')
  })

  test('behavior: returns pathname as-is when no basePath', () => {
    expect(Route.pathname(new URL('http://localhost/openai/v1/models'))).toBe('/openai/v1/models')
  })

  test('error: returns null when basePath does not match', () => {
    expect(
      Route.pathname(new URL('http://localhost/other/openai/v1/models'), '/api/proxy'),
    ).toBeNull()
  })

  test('error: returns null for basePath prefix collision', () => {
    expect(Route.pathname(new URL('http://localhost/proxy2/openai/v1/models'), '/proxy')).toBeNull()
  })

  test('behavior: returns empty string when pathname equals basePath', () => {
    expect(Route.pathname(new URL('http://localhost/proxy'), '/proxy')).toBe('')
  })
})

describe('parse', () => {
  test('behavior: extracts serviceId and upstreamPath', () => {
    expect(Route.parse('/openai/v1/chat/completions')).toMatchInlineSnapshot(`
      {
        "serviceId": "openai",
        "upstreamPath": "/v1/chat/completions",
      }
    `)
  })

  test('behavior: parses anthropic service path', () => {
    expect(Route.parse('/anthropic/v1/messages')).toMatchInlineSnapshot(`
      {
        "serviceId": "anthropic",
        "upstreamPath": "/v1/messages",
      }
    `)
  })

  test('behavior: returns root upstreamPath when no sub-path', () => {
    expect(Route.parse('/stripe')).toMatchInlineSnapshot(`
      {
        "serviceId": "stripe",
        "upstreamPath": "/",
      }
    `)
  })

  test('error: returns null for root path', () => {
    expect(Route.parse('/')).toBeNull()
  })

  test('error: returns null for empty pathname', () => {
    expect(Route.parse('')).toBeNull()
  })
})

describe('match', () => {
  test('behavior: matches exact method and path', () => {
    const routes = { 'POST /v1/chat/completions': 'chat' }
    const result = Route.match(routes, 'POST', '/v1/chat/completions')
    expect(result).toMatchInlineSnapshot(`
      {
        "key": "POST /v1/chat/completions",
        "value": "chat",
      }
    `)
  })

  test('behavior: matches wildcard pattern', () => {
    const routes = { 'POST /v1/images/*': 'images' }
    const result = Route.match(routes, 'POST', '/v1/images/generations')
    expect(result).toMatchInlineSnapshot(`
      {
        "key": "POST /v1/images/*",
        "value": "images",
      }
    `)
  })

  test('behavior: method-less pattern matches any method', () => {
    const routes = { '/v1/*': 'catchall' }
    expect(Route.match(routes, 'GET', '/v1/models')).toMatchInlineSnapshot(`
      {
        "key": "/v1/*",
        "value": "catchall",
      }
    `)
    expect(Route.match(routes, 'POST', '/v1/completions')).toMatchInlineSnapshot(`
      {
        "key": "/v1/*",
        "value": "catchall",
      }
    `)
  })

  test('behavior: matches named params', () => {
    const routes = { 'GET /v1/users/:id': 'user' }
    const result = Route.match(routes, 'GET', '/v1/users/123')
    expect(result).toMatchInlineSnapshot(`
      {
        "key": "GET /v1/users/:id",
        "value": "user",
      }
    `)
  })

  test('behavior: first match wins', () => {
    const routes = {
      'POST /v1/chat/completions': 'specific',
      'POST /v1/*': 'general',
    }
    expect(Route.match(routes, 'POST', '/v1/chat/completions')?.value).toBe('specific')
  })

  test('behavior: case insensitive method matching', () => {
    const routes = { 'POST /v1/chat': 'chat' }
    expect(Route.match(routes, 'post', '/v1/chat')).toMatchInlineSnapshot(`
      {
        "key": "POST /v1/chat",
        "value": "chat",
      }
    `)
  })

  test('error: returns null when no match', () => {
    const routes = { 'POST /v1/chat/completions': 'chat' }
    expect(Route.match(routes, 'POST', '/v2/unknown')).toBeNull()
  })

  test('error: returns null for wrong method', () => {
    const routes = { 'POST /v1/chat/completions': 'chat' }
    expect(Route.match(routes, 'GET', '/v1/chat/completions')).toBeNull()
  })
})

describe('matchPath', () => {
  const paidOnly = (v: unknown) => v !== true

  test('behavior: matches route by path without filter', () => {
    const routes = { 'GET /v1/models': true }
    expect(Route.matchPath(routes, '/v1/models')).toMatchObject({
      key: 'GET /v1/models',
    })
  })

  test('behavior: matches paid endpoint by path', () => {
    const routes = { 'GET /v1/generate': { pay: () => {} } }
    expect(Route.matchPath(routes, '/v1/generate', paidOnly)).toMatchObject({
      key: 'GET /v1/generate',
    })
  })

  test('behavior: skips free passthrough routes with filter', () => {
    const routes = {
      'GET /v1/models': true,
      'POST /v1/generate': { pay: () => {} },
    }
    expect(Route.matchPath(routes, '/v1/models', paidOnly)).toBeNull()
  })

  test('behavior: matches paid route even with different method', () => {
    const routes = {
      'GET /v1/stream': { pay: () => {} },
    }
    expect(Route.matchPath(routes, '/v1/stream', paidOnly)).toMatchObject({
      key: 'GET /v1/stream',
    })
  })

  test('behavior: skips free and matches next paid route', () => {
    const routes = {
      'GET /v1/*': true,
      'POST /v1/*': { pay: () => {} },
    }
    const result = Route.matchPath(routes, '/v1/cachedContents', paidOnly)
    expect(result).toMatchObject({ key: 'POST /v1/*' })
  })

  test('error: returns null when all routes are free', () => {
    const routes = {
      'GET /v1/models': true,
      'GET /v1/status': true,
    }
    expect(Route.matchPath(routes, '/v1/models', paidOnly)).toBeNull()
  })

  test('error: returns null when no path match', () => {
    const routes = { 'POST /v1/generate': { pay: () => {} } }
    expect(Route.matchPath(routes, '/v2/unknown', paidOnly)).toBeNull()
  })
})
