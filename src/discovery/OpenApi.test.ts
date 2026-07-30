import * as Challenge from '../Challenge.js'
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
        interval: z.string(),
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

const transformedCharge = Method.toServer(
  Method.from({
    intent: 'charge',
    name: 'transformed',
    schema: {
      credential: { payload: z.object({ signature: z.string() }) },
      request: z.pipe(
        z.object({
          amount: z.string(),
          asset: z.string(),
          decimals: z.number(),
          recipient: z.string(),
        }),
        z.transform(({ amount, asset, decimals, recipient }) => ({
          amount: String(Number(amount) * 10 ** decimals),
          currency: asset,
          methodDetails: { decimals },
          recipient,
        })),
      ),
    },
  }),
  {
    verify: async () => ({
      method: 'transformed',
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
    secretKey: 'test-secret-key-test-secret-key-32',
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
                "offers": [
                  {
                    "amount": "100",
                    "currency": "0xUSDC",
                    "intent": "charge",
                    "method": "tempo",
                    "recipient": "0x123",
                  },
                ],
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
                "offers": [
                  {
                    "amount": "50",
                    "currency": "usd",
                    "description": "Search credits",
                    "intent": "charge",
                    "method": "tempo",
                    "recipient": "0x1",
                  },
                ],
              },
            },
          },
        },
      }
    `)
  })

  test('matches handler discovery to its canonical runtime challenge', async () => {
    const mppx = createMppx([transformedCharge])
    const handler = mppx.charge({
      amount: '2',
      asset: '0xUSDC',
      decimals: 6,
      description: 'Canonical price',
      recipient: '0x1',
    })

    const doc = generate(mppx, {
      routes: [{ handler, method: 'post', path: '/api/resource' }],
    }) as any
    const result = await handler(new Request('https://example.com/api/resource'))
    if (result.status !== 402) throw new Error('Expected payment challenge')
    const challenge = Challenge.fromResponse(result.challenge)

    expect(doc.paths['/api/resource'].post['x-payment-info'].offers[0]).toEqual({
      amount: challenge.request.amount,
      currency: challenge.request.currency,
      description: challenge.description,
      intent: challenge.intent,
      method: challenge.method,
      recipient: challenge.request.recipient,
    })
  })

  test('applies method schema transforms to legacy route discovery', () => {
    const mppx = createMppx([transformedCharge])
    const doc = generate(mppx, {
      routes: [
        {
          intent: 'charge',
          method: 'post',
          options: {
            amount: '2',
            asset: '0xUSDC',
            decimals: 6,
            description: 'Canonical price',
            recipient: '0x1',
          },
          path: '/api/resource',
        },
      ],
    }) as any

    expect(doc.paths['/api/resource'].post['x-payment-info'].offers[0]).toEqual({
      amount: '2000000',
      currency: '0xUSDC',
      description: 'Canonical price',
      intent: 'charge',
      method: 'transformed',
      recipient: '0x1',
    })
  })

  test('derives only explicitly composed payment offers from a handler', () => {
    const mppx = createMppx([charge, session])
    const handler = mppx.compose(
      ['tempo/charge', { amount: '50', currency: '0xUSDC', description: 'USDC', recipient: '0x1' }],
      [
        'tempo/charge',
        { amount: '50', currency: '0xNANOUSD', description: 'NANOUSD', recipient: '0x1' },
      ],
    )

    const doc = generate(mppx, {
      routes: [{ handler, method: 'post', path: '/api/search' }],
    }) as any

    expect(doc.paths['/api/search'].post['x-payment-info'].offers).toEqual([
      {
        amount: '50',
        currency: '0xUSDC',
        description: 'USDC',
        intent: 'charge',
        method: 'tempo',
        recipient: '0x1',
      },
      {
        amount: '50',
        currency: '0xNANOUSD',
        description: 'NANOUSD',
        intent: 'charge',
        method: 'tempo',
        recipient: '0x1',
      },
    ])
  })

  test('keeps nested composed discovery in runtime challenge order', async () => {
    const mppx = createMppx([charge])
    const handler = Mppx.compose(
      mppx.charge({
        amount: '1',
        currency: '0xUSDC',
        description: 'USDC',
        recipient: '0x1',
      }),
      Mppx.compose(
        mppx.charge({
          amount: '2',
          currency: '0xNANOUSD',
          description: 'NANOUSD',
          recipient: '0x1',
        }),
        mppx.charge({
          amount: '3',
          currency: 'usd',
          description: 'Card',
          recipient: '0x1',
        }),
      ),
    )

    const doc = generate(mppx, {
      routes: [{ handler, method: 'post', path: '/api/search' }],
    }) as any
    const result = await handler(new Request('https://example.com/api/search'))
    if (result.status !== 402) throw new Error('Expected payment challenge')

    const discovered = doc.paths['/api/search'].post['x-payment-info'].offers
    const challenged = Challenge.fromResponseList(result.challenge).map((challenge) => ({
      amount: challenge.request.amount,
      currency: challenge.request.currency,
      description: challenge.description,
      intent: challenge.intent,
      method: challenge.method,
      recipient: challenge.request.recipient,
    }))

    expect(discovered).toEqual(challenged)
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
                "offers": [
                  {
                    "amount": null,
                    "intent": "session",
                    "method": "tempo",
                    "recipient": "0x123",
                  },
                ],
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
                "offers": [
                  {
                    "amount": "100",
                    "currency": "0xUSDC",
                    "intent": "charge",
                    "method": "tempo",
                    "recipient": "0xABC",
                  },
                ],
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
                "offers": [
                  {
                    "amount": "500",
                    "currency": "0xUSDC",
                    "intent": "charge",
                    "method": "tempo",
                    "recipient": "0xABC",
                  },
                ],
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
                "offers": [
                  {
                    "amount": null,
                    "intent": "session",
                    "method": "tempo",
                    "recipient": "0xABC",
                  },
                ],
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

  test('passes through custom intents and extra params', () => {
    const mppx = createMppx([subscribe])
    const doc = generate(mppx, {
      routes: [
        {
          intent: 'subscribe',
          method: 'post',
          options: { amount: '100', interval: 'monthly', recipient: '0xABC' },
          path: '/api/subscribe',
          summary: 'Monthly subscription',
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
          "/api/subscribe": {
            "post": {
              "responses": {
                "200": {
                  "description": "Successful response",
                },
                "402": {
                  "description": "Payment Required",
                },
              },
              "summary": "Monthly subscription",
              "x-payment-info": {
                "offers": [
                  {
                    "amount": "100",
                    "intent": "subscribe",
                    "interval": "monthly",
                    "method": "tempo",
                    "recipient": "0xABC",
                  },
                ],
              },
            },
          },
        },
      }
    `)
  })
})
