import { describe, expect, test } from 'vitest'

import * as Method from '../Method.js'
import * as Mppx from '../server/Mppx.js'
import * as z from '../zod.js'
import { generate } from './OpenApi.js'

const charge = Method.toServer(
  Method.from({
    intent: 'charge',
    name: 'tempo',
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
      method: 'tempo',
      reference: '',
      status: 'success' as const,
      timestamp: '',
    }),
  },
)

const session = Method.toServer(
  Method.from({
    intent: 'session',
    name: 'tempo',
    schema: {
      credential: { payload: z.object({ signature: z.string() }) },
      request: z.object({
        amount: z.union([z.null(), z.string()]),
        recipient: z.string(),
      }),
    },
  }),
  {
    verify: async () => ({
      method: 'tempo',
      reference: '',
      status: 'success' as const,
      timestamp: '',
    }),
  },
)

const subscribe = Method.toServer(
  Method.from({
    intent: 'subscribe',
    name: 'tempo',
    schema: {
      credential: { payload: z.object({ signature: z.string() }) },
      request: z.object({
        amount: z.string(),
      }),
    },
  }),
  {
    verify: async () => ({
      method: 'tempo',
      reference: '',
      status: 'success' as const,
      timestamp: '',
    }),
  },
)

function createMppx<const methods extends Mppx.Methods>(methods: methods) {
  return Mppx.create({
    methods,
    realm: 'test-realm',
    secretKey: 'test-secret',
  })
}

describe('generate', () => {
  test('generates a valid OpenAPI 3.1.0 document for legacy route config', () => {
    const mppx = createMppx([charge])
    const doc = generate(mppx, {
      routes: [
        {
          intent: 'charge',
          method: 'get',
          options: { amount: '100', currency: '0xUSDC', recipient: '0x123' },
          path: '/api/resource',
        },
      ],
    })

    expect(doc.openapi).toBe('3.1.0')
    expect((doc.info as Record<string, unknown>).title).toBe('test-realm')
    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>
    expect(paths['/api/resource']!.get!['x-payment-info']).toEqual({
      amount: '100',
      currency: '0xUSDC',
      intent: 'charge',
      method: 'tempo',
    })
  })

  test('supports handler-derived route config', () => {
    const mppx = createMppx([charge])
    const handler = mppx.charge({
      amount: '50',
      currency: 'usd',
      description: 'Search credits',
      recipient: '0x1',
    })

    const doc = generate(mppx, {
      routes: [
        {
          handler,
          method: 'post',
          path: '/api/search',
        },
      ],
    })

    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>
    expect(paths['/api/search']!.post!['x-payment-info']).toEqual({
      amount: '50',
      currency: 'usd',
      intent: 'charge',
      method: 'tempo',
    })
  })

  test('handles null amount', () => {
    const mppx = createMppx([session])
    const doc = generate(mppx, {
      routes: [
        {
          intent: 'session',
          method: 'post',
          options: { amount: null, recipient: '0x123' },
          path: '/api/stream',
        },
      ],
    })

    const paths = doc.paths as Record<string, Record<string, Record<string, unknown>>>
    expect((paths['/api/stream']!.post!['x-payment-info'] as any).amount).toBeNull()
  })

  test('includes x-service-info when provided', () => {
    const mppx = createMppx([charge])
    const doc = generate(mppx, {
      routes: [],
      serviceInfo: {
        categories: ['ai'],
        docs: { homepage: 'https://example.com' },
      },
    })

    expect(doc['x-service-info']).toEqual({
      categories: ['ai'],
      docs: { homepage: 'https://example.com' },
    })
  })

  test('throws on unsupported public intents', () => {
    const mppx = createMppx([subscribe])
    expect(() =>
      generate(mppx, {
        routes: [
          {
            intent: 'subscribe',
            method: 'post',
            options: { amount: '100' },
            path: '/api/subscribe',
          },
        ],
      }),
    ).toThrow(/supports the public intents "charge" and "session"/)
  })
})
