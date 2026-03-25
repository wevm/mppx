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

    expect(doc).toMatchInlineSnapshot(`
      {
        "info": {
          "title": "test-realm",
          "version": "1.0.0",
        },
        "openapi": "3.1.0",
        "paths": {
          "/api/resource": {
            "get": {
              "responses": {
                "200": {
                  "description": "Successful response",
                },
                "402": {
                  "description": "Payment Required",
                },
              },
              "x-payment-info": {
                "amount": "100",
                "currency": "0xUSDC",
                "intent": "charge",
                "method": "tempo",
              },
            },
          },
        },
      }
    `)
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

    expect(doc).toMatchInlineSnapshot(`
      {
        "info": {
          "title": "test-realm",
          "version": "1.0.0",
        },
        "openapi": "3.1.0",
        "paths": {
          "/api/search": {
            "post": {
              "responses": {
                "200": {
                  "description": "Successful response",
                },
                "402": {
                  "description": "Payment Required",
                },
              },
              "x-payment-info": {
                "amount": "50",
                "currency": "usd",
                "intent": "charge",
                "method": "tempo",
              },
            },
          },
        },
      }
    `)
  })

  test('handles null amount for session intent', () => {
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

    expect(doc).toMatchInlineSnapshot(`
      {
        "info": {
          "title": "test-realm",
          "version": "1.0.0",
        },
        "openapi": "3.1.0",
        "paths": {
          "/api/stream": {
            "post": {
              "responses": {
                "200": {
                  "description": "Successful response",
                },
                "402": {
                  "description": "Payment Required",
                },
              },
              "x-payment-info": {
                "amount": null,
                "intent": "session",
                "method": "tempo",
              },
            },
          },
        },
      }
    `)
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

    expect(doc).toMatchInlineSnapshot(`
      {
        "info": {
          "title": "test-realm",
          "version": "1.0.0",
        },
        "openapi": "3.1.0",
        "paths": {},
        "x-service-info": {
          "categories": [
            "ai",
          ],
          "docs": {
            "homepage": "https://example.com",
          },
        },
      }
    `)
  })

  test('multi-route document with mixed intents', () => {
    const mppx = createMppx([charge, session])
    const doc = generate(mppx, {
      info: { title: 'Multi-Route API', version: '2.0.0' },
      routes: [
        {
          intent: 'charge',
          method: 'post',
          options: { amount: '500', currency: '0xUSDC', recipient: '0xABC' },
          path: '/api/search',
          summary: 'Search the index',
          requestBody: {
            content: { 'application/json': { schema: { type: 'object' } } },
          },
        },
        {
          intent: 'session',
          method: 'post',
          options: { amount: null, recipient: '0xABC' },
          path: '/api/stream',
        },
        {
          intent: 'charge',
          method: 'get',
          options: { amount: '100', currency: '0xUSDC', recipient: '0xABC' },
          path: '/api/models',
        },
      ],
      serviceInfo: {
        categories: ['ai', 'search'],
        docs: {
          apiReference: 'https://example.com/api',
          homepage: 'https://example.com',
          llms: 'https://example.com/llms.txt',
        },
      },
    })

    expect(doc).toMatchInlineSnapshot(`
      {
        "info": {
          "title": "Multi-Route API",
          "version": "2.0.0",
        },
        "openapi": "3.1.0",
        "paths": {
          "/api/models": {
            "get": {
              "responses": {
                "200": {
                  "description": "Successful response",
                },
                "402": {
                  "description": "Payment Required",
                },
              },
              "x-payment-info": {
                "amount": "100",
                "currency": "0xUSDC",
                "intent": "charge",
                "method": "tempo",
              },
            },
          },
          "/api/search": {
            "post": {
              "requestBody": {
                "content": {
                  "application/json": {
                    "schema": {
                      "type": "object",
                    },
                  },
                },
              },
              "responses": {
                "200": {
                  "description": "Successful response",
                },
                "402": {
                  "description": "Payment Required",
                },
              },
              "summary": "Search the index",
              "x-payment-info": {
                "amount": "500",
                "currency": "0xUSDC",
                "intent": "charge",
                "method": "tempo",
              },
            },
          },
          "/api/stream": {
            "post": {
              "responses": {
                "200": {
                  "description": "Successful response",
                },
                "402": {
                  "description": "Payment Required",
                },
              },
              "x-payment-info": {
                "amount": null,
                "intent": "session",
                "method": "tempo",
              },
            },
          },
        },
        "x-service-info": {
          "categories": [
            "ai",
            "search",
          ],
          "docs": {
            "apiReference": "https://example.com/api",
            "homepage": "https://example.com",
            "llms": "https://example.com/llms.txt",
          },
        },
      }
    `)
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
