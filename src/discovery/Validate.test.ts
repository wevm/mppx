import { describe, expect, test } from 'vitest'

import { validate } from './Validate.js'

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
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
          requestBody: {
            content: { 'application/json': { schema: { type: 'object' } } },
          },
          responses: {
            '200': { description: 'OK' },
            '402': { description: 'Payment Required' },
          },
        },
      },
    },
    ...overrides,
  }
}

describe('validate', () => {
  test('returns no errors for a valid document', () => {
    const errors = validate(makeDoc())
    expect(errors.filter((error) => error.severity === 'error')).toHaveLength(0)
  })

  test('returns error for missing 402 response', () => {
    const errors = validate(
      makeDoc({
        paths: {
          '/search': {
            post: {
              'x-payment-info': {
                amount: '100',
                intent: 'charge',
                method: 'tempo',
              },
              requestBody: {},
              responses: {
                '200': { description: 'OK' },
              },
            },
          },
        },
      }),
    )

    expect(errors.find((error) => error.severity === 'error')?.message).toContain('402')
  })

  test('returns warning for missing requestBody', () => {
    const errors = validate(
      makeDoc({
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
      }),
    )

    expect(errors.find((error) => error.severity === 'warning')?.message).toContain('requestBody')
  })

  test('returns structural errors for invalid top-level document', () => {
    const errors = validate({ openapi: '3.1.0' })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]!.severity).toBe('error')
  })

  test('returns errors for invalid extension values', () => {
    const errors = validate(
      makeDoc({
        'x-service-info': {
          docs: { homepage: 'not-a-uri' },
        },
        paths: {
          '/search': {
            post: {
              'x-payment-info': {
                amount: '01',
                intent: 'subscribe',
                method: 'tempo',
              },
              responses: {
                '402': { description: 'Payment Required' },
              },
            },
          },
        },
      }),
    )

    expect(errors.some((error) => error.severity === 'error')).toBe(true)
  })

  test('ignores path-item-level fields like summary and parameters', () => {
    const errors = validate(
      makeDoc({
        paths: {
          '/search': {
            summary: 'Search endpoints',
            parameters: [{ name: 'q', in: 'query' }],
            'x-custom': 'value',
            post: {
              'x-payment-info': {
                amount: '100',
                intent: 'charge',
                method: 'tempo',
              },
              requestBody: {
                content: { 'application/json': { schema: { type: 'object' } } },
              },
              responses: {
                '200': { description: 'OK' },
                '402': { description: 'Payment Required' },
              },
            },
          },
        },
      }),
    )

    expect(errors.filter((e) => e.severity === 'error')).toHaveLength(0)
  })

  test('validates proxy-generated docs with relative llms path', () => {
    const errors = validate({
      info: { title: 'API Proxy', version: '1.0.0' },
      openapi: '3.1.0',
      paths: {},
      'x-service-info': {
        categories: ['gateway'],
        docs: {
          apiReference: 'https://example.com/api',
          homepage: 'https://example.com',
          llms: '/llms.txt',
        },
      },
    })

    expect(errors.filter((e) => e.severity === 'error')).toHaveLength(0)
  })

  test('accepts x-payment-info with unknown fields', () => {
    const errors = validate({
      info: { title: 'Test', version: '1.0.0' },
      openapi: '3.1.0',
      paths: {
        '/api/call': {
          post: {
            'x-payment-info': {
              price: '0.54',
              pricingMode: 'fixed',
              protocols: ['x402', 'mpp'],
            },
            requestBody: {
              content: { 'application/json': { schema: { type: 'object' } } },
            },
            responses: {
              '200': { description: 'OK' },
              '402': { description: 'Payment Required' },
            },
          },
        },
      },
    })
    expect(errors.filter((e) => e.severity === 'error')).toHaveLength(0)
  })
})
