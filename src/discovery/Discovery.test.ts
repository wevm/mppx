import { describe, expect, test } from 'vitest'

import { DiscoveryDocument, PaymentInfo, ServiceInfo } from './Discovery.js'

describe('PaymentInfo', () => {
  test('parses a valid charge payment info', () => {
    const result = PaymentInfo.safeParse({
      amount: '1000',
      intent: 'charge',
      method: 'tempo',
    })
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ amount: '1000', intent: 'charge', method: 'tempo' })
  })

  test('parses a session with null amount', () => {
    const result = PaymentInfo.safeParse({
      amount: null,
      intent: 'session',
      method: 'tempo',
    })
    expect(result.success).toBe(true)
    expect(result.data?.amount).toBeNull()
  })

  test('rejects unsupported public intents', () => {
    const result = PaymentInfo.safeParse({
      amount: '100',
      intent: 'subscribe',
      method: 'tempo',
    })
    expect(result.success).toBe(false)
  })

  test('rejects invalid amount pattern', () => {
    const result = PaymentInfo.safeParse({
      amount: '01',
      intent: 'charge',
      method: 'tempo',
    })
    expect(result.success).toBe(false)
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
  })

  test('rejects missing info', () => {
    const result = DiscoveryDocument.safeParse({
      openapi: '3.1.0',
    })
    expect(result.success).toBe(false)
  })
})
