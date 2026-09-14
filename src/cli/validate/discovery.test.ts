import { afterEach, describe, expect, test, vi } from 'vp/test'

import {
  buildUrl,
  extractEndpointsFromDiscovery,
  extractRequestBodyFromDiscovery,
  validateLlmsDoc,
} from './discovery.js'

describe('buildUrl', () => {
  describe('path parameters', () => {
    test('substitutes param with example from parameter', () => {
      const endpoint = {
        method: 'GET',
        path: '/users/{userId}/posts',
        parameters: [{ name: 'userId', in: 'path' as const, example: 'abc-123' }],
      }
      expect(buildUrl('http://localhost', endpoint)).toBe('http://localhost/users/abc-123/posts')
    })

    test('substitutes param with example from schema', () => {
      const endpoint = {
        method: 'GET',
        path: '/orders/{orderId}',
        parameters: [{ name: 'orderId', in: 'path' as const, schema: { example: 'ORD-001' } }],
      }
      expect(buildUrl('http://localhost', endpoint)).toBe('http://localhost/orders/ORD-001')
    })

    test('substitutes param with default from schema', () => {
      const endpoint = {
        method: 'GET',
        path: '/items/{itemId}',
        parameters: [{ name: 'itemId', in: 'path' as const, schema: { default: '42' } }],
      }
      expect(buildUrl('http://localhost', endpoint)).toBe('http://localhost/items/42')
    })

    test('leaves placeholder when no example available', () => {
      const endpoint = {
        method: 'GET',
        path: '/users/{userId}',
        parameters: [{ name: 'userId', in: 'path' as const, schema: { type: 'string' } }],
      }
      expect(buildUrl('http://localhost', endpoint)).toBe('http://localhost/users/%7BuserId%7D')
    })

    test('handles multiple path params', () => {
      const endpoint = {
        method: 'GET',
        path: '/orgs/{orgId}/repos/{repoId}',
        parameters: [
          { name: 'orgId', in: 'path' as const, example: 'stripe' },
          { name: 'repoId', in: 'path' as const, example: 'mppx' },
        ],
      }
      expect(buildUrl('http://localhost', endpoint)).toBe('http://localhost/orgs/stripe/repos/mppx')
    })

    test('encodes special characters', () => {
      const endpoint = {
        method: 'GET',
        path: '/search/{query}',
        parameters: [{ name: 'query', in: 'path' as const, example: 'hello world' }],
      }
      expect(buildUrl('http://localhost', endpoint)).toBe('http://localhost/search/hello%20world')
    })

    test('no parameters field leaves path as-is', () => {
      const endpoint = { method: 'GET', path: '/simple' }
      expect(buildUrl('http://localhost', endpoint)).toBe('http://localhost/simple')
    })
  })

  describe('subpath base URL', () => {
    test('preserves base URL subpath', () => {
      const endpoint = { method: 'POST', path: '/plan' }
      expect(buildUrl('http://localhost/mpp', endpoint)).toBe('http://localhost/mpp/plan')
    })

    test('preserves nested subpath', () => {
      const endpoint = { method: 'GET', path: '/users/123' }
      expect(buildUrl('http://localhost/api/v1', endpoint)).toBe(
        'http://localhost/api/v1/users/123',
      )
    })

    test('works with trailing slash on base', () => {
      const endpoint = { method: 'POST', path: '/plan' }
      expect(buildUrl('http://localhost/mpp/', endpoint)).toBe('http://localhost/mpp/plan')
    })
  })
})

describe('extractEndpointsFromDiscovery', () => {
  describe('path parameters', () => {
    test('extracts parameters from OpenAPI doc', () => {
      const doc = {
        openapi: '3.1.0',
        paths: {
          '/users/{userId}': {
            parameters: [
              { name: 'userId', in: 'path', schema: { type: 'string', example: 'u-1' } },
            ],
            get: {
              'x-payment-info': { amount: '100' },
              responses: { '402': {} },
            },
          },
        },
      }
      const endpoints = extractEndpointsFromDiscovery(doc as Record<string, unknown>)
      expect(endpoints).toHaveLength(1)
      expect(endpoints[0]!.parameters).toHaveLength(1)
      expect(endpoints[0]!.parameters![0]!.name).toBe('userId')
      expect(buildUrl('http://localhost', endpoints[0]!)).toBe('http://localhost/users/u-1')
    })

    test('operation params override path-level params', () => {
      const doc = {
        openapi: '3.1.0',
        paths: {
          '/items/{id}': {
            parameters: [{ name: 'id', in: 'path', example: 'path-level' }],
            post: {
              'x-payment-info': { amount: '100' },
              parameters: [{ name: 'id', in: 'path', example: 'op-level' }],
            },
          },
        },
      }
      const endpoints = extractEndpointsFromDiscovery(doc as Record<string, unknown>)
      expect(buildUrl('http://localhost', endpoints[0]!)).toBe('http://localhost/items/op-level')
    })
  })

  describe('endpoint selection', () => {
    test('prefers x-payment-info endpoints over 402 heuristic', () => {
      const doc = {
        paths: {
          '/paid': { post: { 'x-payment-info': { amount: '100' }, responses: { '402': {} } } },
          '/maybe': { get: { responses: { '402': {} } } },
        },
      }
      const endpoints = extractEndpointsFromDiscovery(doc as Record<string, unknown>)
      expect(endpoints).toHaveLength(1)
      expect(endpoints[0]!.path).toBe('/paid')
    })

    test('falls back to 402 heuristic when no x-payment-info', () => {
      const doc = {
        paths: {
          '/a': { get: { responses: { '402': {} } } },
          '/b': { post: { responses: { '402': {} } } },
        },
      }
      const endpoints = extractEndpointsFromDiscovery(doc as Record<string, unknown>)
      expect(endpoints).toHaveLength(2)
    })

    test('returns empty for no paths', () => {
      expect(extractEndpointsFromDiscovery({} as Record<string, unknown>)).toEqual([])
    })

    test('captures amount from x-payment-info', () => {
      const doc = {
        paths: {
          '/api/generate': {
            post: { 'x-payment-info': { amount: '50000' }, responses: { '402': {} } },
          },
        },
      }
      const endpoints = extractEndpointsFromDiscovery(doc as Record<string, unknown>)
      expect(endpoints[0]!.amount).toBe('50000')
    })
  })
})

describe('extractRequestBodyFromDiscovery', () => {
  test('returns explicit example from content', () => {
    const doc = {
      paths: {
        '/api/test': {
          post: {
            requestBody: {
              content: {
                'application/json': { example: { prompt: 'hello' } },
              },
            },
          },
        },
      },
    }
    const body = extractRequestBodyFromDiscovery(doc as Record<string, unknown>, {
      method: 'POST',
      path: '/api/test',
    })
    expect(body).toBe('{"prompt":"hello"}')
  })

  test('generates body from schema with required fields', () => {
    const doc = {
      paths: {
        '/api/test': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['query', 'count'],
                    properties: {
                      query: { type: 'string', example: 'test query' },
                      count: { type: 'integer', default: 10 },
                      optional: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }
    const body = extractRequestBodyFromDiscovery(doc as Record<string, unknown>, {
      method: 'POST',
      path: '/api/test',
    })
    expect(JSON.parse(body!)).toEqual({ query: 'test query', count: 10 })
  })

  test('uses schema defaults for scalar types', () => {
    const doc = {
      paths: {
        '/api/test': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['email', 'active'],
                    properties: {
                      email: { type: 'string', format: 'email' },
                      active: { type: 'boolean' },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }
    const body = extractRequestBodyFromDiscovery(doc as Record<string, unknown>, {
      method: 'POST',
      path: '/api/test',
    })
    expect(JSON.parse(body!)).toEqual({ email: 'test@example.com', active: true })
  })

  test('returns undefined when no requestBody', () => {
    const doc = { paths: { '/api/test': { post: {} } } }
    const body = extractRequestBodyFromDiscovery(doc as Record<string, unknown>, {
      method: 'POST',
      path: '/api/test',
    })
    expect(body).toBeUndefined()
  })

  test('returns undefined when path not found', () => {
    const doc = { paths: { '/other': { get: {} } } }
    const body = extractRequestBodyFromDiscovery(doc as Record<string, unknown>, {
      method: 'POST',
      path: '/api/test',
    })
    expect(body).toBeUndefined()
  })

  test('handles enum in schema', () => {
    const doc = {
      paths: {
        '/api/test': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['model'],
                    properties: {
                      model: { type: 'string', enum: ['gpt-4', 'gpt-3.5'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    }
    const body = extractRequestBodyFromDiscovery(doc as Record<string, unknown>, {
      method: 'POST',
      path: '/api/test',
    })
    expect(JSON.parse(body!)).toEqual({ model: 'gpt-4' })
  })

  test('resolves $ref to components/schemas', () => {
    const doc = {
      paths: {
        '/api/orders': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/OrderRequest' },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          OrderRequest: {
            type: 'object',
            required: ['product', 'quantity'],
            properties: {
              product: { type: 'string', example: 'widget' },
              quantity: { type: 'integer', minimum: 1 },
            },
          },
        },
      },
    }
    const body = extractRequestBodyFromDiscovery(doc as Record<string, unknown>, {
      method: 'POST',
      path: '/api/orders',
    })
    expect(JSON.parse(body!)).toEqual({ product: 'widget', quantity: 1 })
  })

  test('resolves nested $ref in properties', () => {
    const doc = {
      paths: {
        '/api/orders': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/OrderRequest' },
                },
              },
            },
          },
        },
      },
      components: {
        schemas: {
          OrderRequest: {
            type: 'object',
            required: ['customer'],
            properties: {
              customer: { $ref: '#/components/schemas/Customer' },
            },
          },
          Customer: {
            type: 'object',
            required: ['name', 'email'],
            properties: {
              name: { type: 'string' },
              email: { type: 'string', format: 'email' },
            },
          },
        },
      },
    }
    const body = extractRequestBodyFromDiscovery(doc as Record<string, unknown>, {
      method: 'POST',
      path: '/api/orders',
    })
    expect(JSON.parse(body!)).toEqual({ customer: { name: 'test', email: 'test@example.com' } })
  })

  test('uses first named example from examples map', () => {
    const doc = {
      paths: {
        '/api/test': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  examples: {
                    basic: { value: { prompt: 'hello', model: 'gpt-4' } },
                    advanced: { value: { prompt: 'complex', model: 'gpt-4', temp: 0.9 } },
                  },
                  schema: { type: 'object' },
                },
              },
            },
          },
        },
      },
    }
    const body = extractRequestBodyFromDiscovery(doc as Record<string, unknown>, {
      method: 'POST',
      path: '/api/test',
    })
    expect(JSON.parse(body!)).toEqual({ prompt: 'hello', model: 'gpt-4' })
  })

  test('returns undefined for unresolvable $ref', () => {
    const doc = {
      paths: {
        '/api/test': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/DoesNotExist' },
                },
              },
            },
          },
        },
      },
      components: { schemas: {} },
    }
    const body = extractRequestBodyFromDiscovery(doc as Record<string, unknown>, {
      method: 'POST',
      path: '/api/test',
    })
    expect(body).toBeUndefined()
  })
})

describe('validateLlmsDoc', () => {
  afterEach(() => vi.restoreAllMocks())

  test('passes when llms.txt is present', async () => {
    const fetch = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response('# API\n\nDocumentation', { headers: { 'content-type': 'text/plain' } }),
      )

    expect(await validateLlmsDoc('https://example.com/api')).toMatchObject({ severity: 'pass' })
    expect(fetch).toHaveBeenCalledWith('https://example.com/llms.txt', expect.anything())
  })

  test('suggests adding llms.txt when missing', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Not found', { status: 404 }))

    expect(await validateLlmsDoc('https://example.com')).toMatchObject({ severity: 'suggested' })
  })
})
