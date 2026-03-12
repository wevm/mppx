import { describe, expect, test } from 'vitest'
import { validate } from './Validate.js'

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    openapi: '3.1.0',
    info: { title: 'Test', version: '1.0.0' },
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
          requestBody: {
            content: { 'application/json': { schema: { type: 'object' } } },
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
    expect(errors.filter((e) => e.severity === 'error')).toHaveLength(0)
  })

  test('returns error for missing 402 response', () => {
    const doc = makeDoc({
      paths: {
        '/search': {
          post: {
            'x-payment-info': {
              intent: 'charge',
              method: 'tempo',
              amount: '100',
            },
            responses: {
              '200': { description: 'OK' },
            },
            requestBody: {},
          },
        },
      },
    })
    const errors = validate(doc)
    const err = errors.find((e) => e.severity === 'error')!
    expect(err).toBeDefined()
    expect(err.message).toContain('402')
  })

  test('returns warning for missing requestBody', () => {
    const doc = makeDoc({
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
    const errors = validate(doc)
    const warn = errors.find((e) => e.severity === 'warning')!
    expect(warn).toBeDefined()
    expect(warn.message).toContain('requestBody')
  })

  test('returns error for invalid x-payment-info fields', () => {
    const doc = makeDoc({
      paths: {
        '/search': {
          post: {
            'x-payment-info': {
              intent: 'invalid',
              method: 'tempo',
              amount: '01',
            },
            responses: {
              '402': { description: 'Payment Required' },
            },
            requestBody: {},
          },
        },
      },
    })
    const errors = validate(doc)
    expect(errors.some((e) => e.severity === 'error')).toBe(true)
  })

  test('returns structural errors for invalid top-level document', () => {
    const errors = validate({ openapi: '3.1.0' })
    expect(errors.length).toBeGreaterThan(0)
    expect(errors[0]!.severity).toBe('error')
  })

  test('returns no errors for document with no paths', () => {
    const errors = validate({
      openapi: '3.1.0',
      info: { title: 'Test', version: '1.0.0' },
    })
    expect(errors).toHaveLength(0)
  })

  test('returns no errors for operations without x-payment-info', () => {
    const doc = makeDoc({
      paths: {
        '/health': {
          get: {
            responses: { '200': { description: 'OK' } },
          },
        },
      },
    })
    const errors = validate(doc)
    expect(errors).toHaveLength(0)
  })

  test('returns error when responses object is entirely missing', () => {
    const doc = makeDoc({
      paths: {
        '/search': {
          post: {
            'x-payment-info': {
              intent: 'charge',
              method: 'tempo',
              amount: '100',
            },
            requestBody: {},
          },
        },
      },
    })
    const errors = validate(doc)
    const err = errors.find((e) => e.severity === 'error' && e.message.includes('402'))!
    expect(err).toBeDefined()
  })
})
