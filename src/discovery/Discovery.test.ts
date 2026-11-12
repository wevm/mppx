import { DiscoveryDocument, listOperations, PaymentInfo, ServiceInfo } from './Discovery.js'

describe('PaymentInfo', () => {
  test('normalizes legacy shorthand to offers', () => {
    const result = PaymentInfo.safeParse({
      amount: '1000',
      intent: 'charge',
      method: 'tempo',
    })
    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      offers: [{ amount: '1000', intent: 'charge', method: 'tempo' }],
    })
  })

  test('parses offers format without modification', () => {
    const result = PaymentInfo.safeParse({
      offers: [{ amount: '1000', intent: 'charge', method: 'tempo' }],
    })
    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      offers: [{ amount: '1000', intent: 'charge', method: 'tempo' }],
    })
  })

  test('parses a session with null amount', () => {
    const result = PaymentInfo.safeParse({
      amount: null,
      intent: 'session',
      method: 'tempo',
    })
    expect(result.success).toBe(true)
    expect(result.data?.offers[0]?.amount).toBeNull()
  })

  test('accepts custom intents', () => {
    const result = PaymentInfo.safeParse({
      amount: '100',
      intent: 'subscribe',
      method: 'tempo',
    })
    expect(result.success).toBe(true)
    expect(result.data?.offers[0]?.intent).toBe('subscribe')
  })

  test('rejects invalid amount pattern', () => {
    const result = PaymentInfo.safeParse({
      amount: '01',
      intent: 'charge',
      method: 'tempo',
    })
    expect(result.success).toBe(false)
  })

  test('rejects mixed shorthand and offers shapes', () => {
    const result = PaymentInfo.safeParse({
      amount: '100',
      offers: [{ amount: '100', intent: 'charge', method: 'tempo' }],
    })
    expect(result.success).toBe(false)
  })

  test('rejects empty offers arrays', () => {
    const result = PaymentInfo.safeParse({ offers: [] })
    expect(result.success).toBe(false)
  })

  test('ignores unknown fields next to offers', () => {
    // Only the spec-defined flat fields conflict with `offers`; unknown
    // extension keys are ignored, as documented on the schema.
    const result = PaymentInfo.safeParse({
      offers: [{ amount: '1000', intent: 'charge', method: 'tempo' }],
      price: '0.001',
      protocols: ['mpp'],
    })
    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      offers: [{ amount: '1000', intent: 'charge', method: 'tempo' }],
    })
  })

  test('rejects malformed offers', () => {
    const result = PaymentInfo.safeParse({
      offers: [{ amount: '01', intent: 'charge', method: 'tempo' }],
    })
    expect(result.success).toBe(false)
  })

  test('accepts x402 format with unknown fields', () => {
    const result = PaymentInfo.safeParse({
      price: '0.54',
      pricingMode: 'fixed',
      protocols: ['x402', 'mpp'],
    })
    expect(result.success).toBe(true)
    expect(result.data).toEqual({
      offers: [{ price: '0.54', pricingMode: 'fixed', protocols: ['x402', 'mpp'] }],
    })
  })
})

describe('ServiceInfo', () => {
  test('parses a full service info', () => {
    const result = ServiceInfo.safeParse({
      categories: ['ai', 'search'],
      docs: {
        apiReference: 'https://example.com/api',
        homepage: 'https://example.com',
        llms: 'https://example.com/llms.txt',
      },
    })
    expect(result.success).toBe(true)
    expect(result.data?.categories).toEqual(['ai', 'search'])
  })

  test('accepts relative paths for doc links', () => {
    const result = ServiceInfo.safeParse({
      docs: {
        llms: '/llms.txt',
        apiReference: '/docs/api',
      },
    })
    expect(result.success).toBe(true)
    expect(result.data?.docs?.llms).toBe('/llms.txt')
  })

  test('rejects invalid doc URIs', () => {
    const result = ServiceInfo.safeParse({
      docs: {
        homepage: 'not-a-uri',
      },
    })
    expect(result.success).toBe(false)
  })
})

describe('DiscoveryDocument', () => {
  test('parses a minimal document', () => {
    const result = DiscoveryDocument.safeParse({
      info: { title: 'Test', version: '1.0.0' },
      openapi: '3.1.0',
    })
    expect(result.success).toBe(true)
  })

  test('parses a document with discovery extensions', () => {
    const result = DiscoveryDocument.safeParse({
      info: { title: 'Test', version: '1.0.0' },
      openapi: '3.1.0',
      paths: {
        '/search': {
          post: {
            'x-payment-info': {
              amount: '100',
              intent: 'charge',
              method: 'tempo',
            },
            responses: {
              '200': { description: 'OK' },
              '402': { description: 'Payment Required' },
            },
          },
        },
      },
      'x-service-info': {
        categories: ['search'],
      },
    })
    expect(result.success).toBe(true)
    expect(result.data?.paths?.['/search']?.post?.['x-payment-info']).toEqual({
      offers: [{ amount: '100', intent: 'charge', method: 'tempo' }],
    })
  })

  test('normalizes offers-based discovery documents', () => {
    const result = DiscoveryDocument.safeParse({
      info: { title: 'Test', version: '1.0.0' },
      openapi: '3.1.0',
      paths: {
        '/search': {
          post: {
            'x-payment-info': {
              offers: [{ amount: '100', intent: 'charge', method: 'tempo' }],
            },
            responses: {
              '200': { description: 'OK' },
              '402': { description: 'Payment Required' },
            },
          },
        },
      },
    })
    expect(result.success).toBe(true)
    expect(result.data?.paths?.['/search']?.post?.['x-payment-info']).toEqual({
      offers: [{ amount: '100', intent: 'charge', method: 'tempo' }],
    })
  })

  test('accepts path items with summary, parameters, and extensions', () => {
    const result = DiscoveryDocument.safeParse({
      info: { title: 'Test', version: '1.0.0' },
      openapi: '3.1.0',
      paths: {
        '/search': {
          summary: 'Search endpoints',
          parameters: [{ name: 'q', in: 'query' }],
          'x-custom': 'hello',
          post: {
            'x-payment-info': {
              amount: '100',
              intent: 'charge',
              method: 'tempo',
            },
            responses: { '402': { description: 'Payment Required' } },
          },
        },
      },
    })
    expect(result.success).toBe(true)
  })

  test('rejects missing info', () => {
    const result = DiscoveryDocument.safeParse({
      openapi: '3.1.0',
    })
    expect(result.success).toBe(false)
  })
})

describe('listOperations', () => {
  const doc = {
    openapi: '3.1.0',
    info: { title: 'Forecast API', version: '1.0.0' },
    paths: {
      '/v1/forecast': {
        post: {
          summary: 'Forecast',
          'x-payment-info': {
            amount: '2000',
            currency: '0x20c0',
            intent: 'charge',
            method: 'tempo',
          },
          requestBody: {
            content: {
              'application/json': {
                schema: { type: 'object', properties: { city: { type: 'string' } } },
              },
            },
          },
          responses: { '200': { description: 'OK' }, '402': { description: 'Payment Required' } },
        },
        get: { responses: { '200': { description: 'OK' } } },
      },
    },
  }

  test('flattens operations with typed offers and request schemas', () => {
    const operations = listOperations(doc)
    expect(operations).toEqual([
      {
        method: 'get',
        path: '/v1/forecast',
        offers: [],
        requestSchema: undefined,
        summary: undefined,
      },
      {
        method: 'post',
        path: '/v1/forecast',
        offers: [{ amount: '2000', currency: '0x20c0', intent: 'charge', method: 'tempo' }],
        requestSchema: { type: 'object', properties: { city: { type: 'string' } } },
        summary: 'Forecast',
      },
    ])
    expectTypeOf(operations[1]!.offers[0]!.amount).toEqualTypeOf<string | null | undefined>()
  })

  test('accepts an already parsed document', () => {
    expect(listOperations(DiscoveryDocument.parse(doc))).toEqual(listOperations(doc))
  })

  test('keeps boolean request schemas', () => {
    const operations = listOperations({
      openapi: '3.1.0',
      info: { title: 'Boolean', version: '1' },
      paths: {
        '/none': { post: { requestBody: { content: { 'application/json': { schema: false } } } } },
        '/any': { post: { requestBody: { content: { 'application/json': { schema: true } } } } },
      },
    })
    expect(operations.map((operation) => operation.requestSchema)).toEqual([false, true])
  })

  test('follows local $refs to request bodies and schemas', () => {
    const operations = listOperations({
      openapi: '3.1.0',
      info: { title: 'Refs', version: '1' },
      components: {
        requestBodies: {
          Forecast: { $ref: '#/components/requestBodies/Inline' },
          Inline: {
            content: { 'application/json': { schema: { $ref: '#/components/schemas/Forecast' } } },
          },
        },
        schemas: { Forecast: { type: 'object', properties: { city: { type: 'string' } } } },
      },
      paths: {
        '/body': { post: { requestBody: { $ref: '#/components/requestBodies/Forecast' } } },
        '/remote': { post: { requestBody: { $ref: 'https://example.com/body.json' } } },
        '/loop': { post: { requestBody: { $ref: '#/paths/~1loop/post/requestBody' } } },
      },
    })
    expect(operations.map((operation) => operation.requestSchema)).toEqual([
      { type: 'object', properties: { city: { type: 'string' } } },
      undefined,
      undefined,
    ])
  })

  test('keeps keywords next to a schema $ref', () => {
    const [operation] = listOperations({
      openapi: '3.1.0',
      info: { title: 'Siblings', version: '1' },
      components: { schemas: { Text: { type: 'string' } } },
      paths: {
        '/style': {
          post: {
            requestBody: {
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Text', maxLength: 10 },
                },
              },
            },
          },
        },
      },
    })
    expect(operation!.requestSchema).toEqual({ maxLength: 10, allOf: [{ type: 'string' }] })
  })

  test('walks a shared $ref chain once', () => {
    const size = 1000
    const requestBodies: Record<string, unknown> = {
      [`B${size}`]: { content: { 'application/json': { schema: { type: 'object' } } } },
    }
    const paths: Record<string, unknown> = {}
    for (let i = 0; i < size; i++) {
      requestBodies[`B${i}`] = { $ref: `#/components/requestBodies/B${i + 1}` }
      paths[`/op${i}`] = { post: { requestBody: { $ref: '#/components/requestBodies/B0' } } }
    }
    const start = performance.now()
    const operations = listOperations({
      openapi: '3.1.0',
      info: { title: 'Chain', version: '1' },
      components: { requestBodies },
      paths,
    })
    expect(performance.now() - start).toBeLessThan(1000)
    expect(operations).toHaveLength(size)
    expect(
      operations.every(
        (operation) => (operation.requestSchema as { type?: string })?.type === 'object',
      ),
    ).toBe(true)
  })

  test('ignores a $ref with malformed percent-encoding', () => {
    const [operation] = listOperations({
      openapi: '3.1.0',
      info: { title: 'Malformed', version: '1' },
      paths: { '/bad': { post: { requestBody: { $ref: '#/%E0' } } } },
    })
    expect(operation!.requestSchema).toBeUndefined()
  })

  test('percent-decodes a $ref fragment before splitting it', () => {
    const [operation] = listOperations({
      openapi: '3.1.0',
      info: { title: 'Encoded', version: '1' },
      components: {
        requestBodies: {
          'a b': { content: { 'application/json': { schema: { type: 'string' } } } },
        },
      },
      paths: {
        '/encoded': { post: { requestBody: { $ref: '#%2Fcomponents%2FrequestBodies%2Fa%20b' } } },
      },
    })
    expect(operation!.requestSchema).toEqual({ type: 'string' })
  })

  test('shares one merged schema across operations that share a $ref with siblings', () => {
    const paths: Record<string, unknown> = {}
    for (let i = 0; i < 3; i++)
      paths[`/op${i}`] = { post: { requestBody: { $ref: '#/components/requestBodies/Shared' } } }
    const operations = listOperations({
      openapi: '3.1.0',
      info: { title: 'Shared', version: '1' },
      components: {
        requestBodies: {
          Shared: {
            content: {
              'application/json': {
                schema: { $ref: '#/components/schemas/Text', allOf: [{ minLength: 1 }] },
              },
            },
          },
        },
        schemas: { Text: { type: 'string' } },
      },
      paths,
    })
    expect(operations[0]!.requestSchema).toEqual({ allOf: [{ type: 'string' }, { minLength: 1 }] })
    expect(operations[1]!.requestSchema).toBe(operations[0]!.requestSchema)
    expect(operations[2]!.requestSchema).toBe(operations[0]!.requestSchema)
  })

  test('follows a long $ref chain without overflowing the stack', () => {
    const size = 50_000
    const requestBodies: Record<string, unknown> = {
      [`B${size}`]: { content: { 'application/json': { schema: { type: 'object' } } } },
    }
    for (let i = 0; i < size; i++)
      requestBodies[`B${i}`] = { $ref: `#/components/requestBodies/B${i + 1}` }
    const [operation] = listOperations({
      openapi: '3.1.0',
      info: { title: 'Long chain', version: '1' },
      components: { requestBodies },
      paths: { '/op': { post: { requestBody: { $ref: '#/components/requestBodies/B0' } } } },
    })
    expect(operation!.requestSchema).toEqual({ type: 'object' })
  })

  test('returns no operations without paths', () => {
    expect(listOperations({ openapi: '3.1.0', info: { title: 'Empty', version: '1' } })).toEqual([])
  })

  test('throws on an invalid document', () => {
    expect(() => listOperations({ openapi: '3.1.0' })).toThrow()
  })
})
