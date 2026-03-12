import { describe, expect, test } from 'vitest'
import { DiscoveryDocument, PaymentInfo, ServiceInfo } from './Discovery.js'

describe('PaymentInfo', () => {
  test('parses a valid charge payment info', () => {
    const result = PaymentInfo.safeParse({
      intent: 'charge',
      method: 'tempo',
      amount: '1000',
    })
    expect(result.success).toBe(true)
    expect(result.data).toEqual({ intent: 'charge', method: 'tempo', amount: '1000' })
  })

  test('parses a session with null amount', () => {
    const result = PaymentInfo.safeParse({
      intent: 'session',
      method: 'tempo',
      amount: null,
    })
    expect(result.success).toBe(true)
    expect(result.data?.amount).toBeNull()
  })

  test('parses with optional currency and description', () => {
    const result = PaymentInfo.safeParse({
      intent: 'charge',
      method: 'stripe',
      amount: '500',
      currency: 'usd',
      description: 'Premium access',
    })
    expect(result.success).toBe(true)
    expect(result.data?.currency).toBe('usd')
    expect(result.data?.description).toBe('Premium access')
  })

  test('rejects invalid intent', () => {
    const result = PaymentInfo.safeParse({
      intent: 'subscribe',
      method: 'tempo',
      amount: '100',
    })
    expect(result.success).toBe(false)
  })

  test('rejects invalid amount pattern', () => {
    const result = PaymentInfo.safeParse({
      intent: 'charge',
      method: 'tempo',
      amount: '01',
    })
    expect(result.success).toBe(false)
  })

  test('rejects missing required fields', () => {
    const result = PaymentInfo.safeParse({ intent: 'charge' })
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

  test('parses an empty object', () => {
    const result = ServiceInfo.safeParse({})
    expect(result.success).toBe(true)
  })

  test('parses with partial docs', () => {
    const result = ServiceInfo.safeParse({
      docs: { homepage: 'https://example.com' },
    })
    expect(result.success).toBe(true)
    expect(result.data?.docs?.homepage).toBe('https://example.com')
  })
})

describe('DiscoveryDocument', () => {
  test('parses a minimal document', () => {
    const result = DiscoveryDocument.safeParse({
      openapi: '3.1.0',
      info: { title: 'Test', version: '1.0.0' },
    })
    expect(result.success).toBe(true)
  })

  test('parses a document with paths and x-payment-info', () => {
    const result = DiscoveryDocument.safeParse({
      openapi: '3.1.0',
      info: { title: 'Test', version: '1.0.0' },
      'x-service-info': {
        categories: ['search'],
      },
      paths: {
        '/search': {
          post: {
            'x-payment-info': {
              intent: 'charge',
              method: 'tempo',
              amount: '100',
            },
            responses: {
              '402': { description: 'Payment Required' },
              '200': { description: 'OK' },
            },
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
