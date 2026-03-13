import { describe, expect, test } from 'vitest'
import * as Method from '../Method.js'
import * as Mppx from '../server/Mppx.js'
import * as z from '../zod.js'
import { generate } from './OpenApi.js'

const charge = Method.toServer(
  Method.from({
    name: 'tempo',
    intent: 'charge',
    schema: {
      credential: { payload: z.object({ signature: z.string() }) },
      request: z.object({
        amount: z.string(),
        currency: z.string(),
        recipient: z.string(),
      }),
    },
  }),
  {
    verify: async () => ({
      status: 'success' as const,
      method: 'tempo',
      timestamp: '',
      reference: '',
    }),
  },
)

const session = Method.toServer(
  Method.from({
    name: 'tempo',
    intent: 'session',
    schema: {
      credential: { payload: z.object({ signature: z.string() }) },
      request: z.object({
        amount: z.string(),
        recipient: z.string(),
      }),
    },
  }),
  {
    verify: async () => ({
      status: 'success' as const,
      method: 'tempo',
      timestamp: '',
      reference: '',
    }),
  },
)

function createMppx(methods: Mppx.Methods) {
  return Mppx.create({
    methods,
    realm: 'test-realm',
    secretKey: 'test-secret',
  })
}

describe('generate', () => {
  test('generates a valid OpenAPI 3.1.0 document', () => {
    const mppx = createMppx([charge])
    const doc = generate(mppx, {
      routes: [
        {
          path: '/api/resource',
          method: 'get',
          intent: 'charge',
          options: { amount: '100', currency: '0xUSDC', recipient: '0x123' },
        },
      ],
    })

    expect(doc.openapi).toBe('3.1.0')
    expect((doc.info as Record<string, unknown>).title).toBe('test-realm')
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>
    expect(paths['/api/resource']!.get!['x-payment-info']).toEqual({
      intent: 'charge',
      method: 'tempo',
      amount: '100',
      currency: '0xUSDC',
    })
    expect(paths['/api/resource']!.get!.responses).toBeDefined()
  })

  test('includes x-service-info when provided', () => {
    const mppx = createMppx([charge])
    const doc = generate(mppx, {
      serviceInfo: {
        categories: ['ai'],
        docs: { homepage: 'https://example.com' },
      },
      routes: [],
    })

    const info = doc['x-service-info'] as Record<string, unknown>
    expect((info as any).categories).toEqual(['ai'])
    expect((info as any).docs).toEqual({ homepage: 'https://example.com' })
  })

  test('handles null amount', () => {
    const mppx = createMppx([session])
    const doc = generate(mppx, {
      routes: [
        {
          path: '/api/stream',
          method: 'post',
          intent: 'session',
          options: { amount: null, recipient: '0x123' },
        },
      ],
    })

    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>
    expect((paths['/api/stream']!.post!['x-payment-info'] as any).amount).toBeNull()
  })

  test('resolves intent via canonical key (name/intent)', () => {
    const mppx = createMppx([charge])
    const doc = generate(mppx, {
      routes: [
        {
          path: '/api/resource',
          method: 'get',
          intent: 'tempo/charge',
          options: { amount: '50', currency: 'usd', recipient: '0x1' },
        },
      ],
    })

    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>
    expect((paths['/api/resource']!.get!['x-payment-info'] as any).intent).toBe('charge')
  })

  test('includes summary and requestBody when provided', () => {
    const mppx = createMppx([charge])
    const doc = generate(mppx, {
      routes: [
        {
          path: '/api/search',
          method: 'post',
          intent: 'charge',
          options: { amount: '10', currency: 'usd', recipient: '0x1' },
          summary: 'Search endpoint',
          requestBody: {
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
      ],
    })

    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>
    expect(paths['/api/search']!.post!.summary).toBe('Search endpoint')
    expect(paths['/api/search']!.post!.requestBody).toBeDefined()
  })

  test('throws on unknown intent', () => {
    const mppx = createMppx([charge])
    expect(() =>
      generate(mppx, {
        routes: [
          {
            path: '/api/unknown',
            method: 'get',
            intent: 'unknown',
            options: {},
          },
        ],
      }),
    ).toThrow(/Unknown intent "unknown"/)
  })

  test('allows overriding info.title and info.version', () => {
    const mppx = createMppx([charge])
    const doc = generate(mppx, {
      info: { title: 'My Service', version: '2.0.0' },
      routes: [],
    })

    expect((doc.info as Record<string, unknown>).title).toBe('My Service')
    expect((doc.info as Record<string, unknown>).version).toBe('2.0.0')
  })
})
