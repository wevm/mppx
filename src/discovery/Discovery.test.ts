import { DiscoveryDocument, PaymentInfo, ServiceInfo } from './Discovery.js'

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
