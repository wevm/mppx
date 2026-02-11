import { describe, expect, test } from 'vitest'

import * as Route from './Route.js'

describe('parse', () => {
  test('behavior: extracts serviceId and upstreamPath', () => {
    expect(
      Route.parse(new URL('http://localhost/openai/v1/chat/completions')),
    ).toMatchInlineSnapshot(`
      {
        "serviceId": "openai",
        "upstreamPath": "/v1/chat/completions",
      }
    `)
  })

  test('behavior: parses anthropic service path', () => {
    expect(Route.parse(new URL('http://localhost/anthropic/v1/messages'))).toMatchInlineSnapshot(`
      {
        "serviceId": "anthropic",
        "upstreamPath": "/v1/messages",
      }
    `)
  })

  test('behavior: returns root upstreamPath when no sub-path', () => {
    expect(Route.parse(new URL('http://localhost/stripe'))).toMatchInlineSnapshot(`
      {
        "serviceId": "stripe",
        "upstreamPath": "/",
      }
    `)
  })

  test('error: returns null for root path', () => {
    expect(Route.parse(new URL('http://localhost/'))).toBeNull()
  })

  test('error: returns null for empty pathname', () => {
    expect(Route.parse(new URL('http://localhost'))).toBeNull()
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
