import * as http from 'node:http'

import { Elysia } from 'elysia'
import { Receipt } from 'mppx'
import { Mppx as Mppx_client, session as sessionIntent, tempo as tempo_client } from 'mppx/client'
import { Mppx, discovery, payment } from 'mppx/elysia'
import { tempo as tempo_server } from 'mppx/server'
import { Addresses } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vp/test'
import * as TestHttp from '~test/Http.js'
import { accounts, asset, client, fundAccount } from '~test/tempo/viem.js'

import * as Scope from '../server/internal/scope.js'

function createServer(app: Elysia<any, any, any, any, any, any, any>) {
  return new Promise<TestHttp.TestServer>((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = `http://localhost${req.url}`
      const headers = new Headers()
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!)
      const request = new Request(url, { method: req.method!, headers })
      const response = await app.fetch(request)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      const body = await response.text()
      if (body) res.write(body)
      res.end()
    })
    server.listen(0, () => {
      const { port } = server.address() as { port: number }
      resolve(TestHttp.wrapServer(server, { port, url: `http://localhost:${port}` }))
    })
  })
}

const secretKey = 'test-secret-key-test-secret-key-32'

describe('payment', () => {
  test('attaches the Elysia route template as payment scope', async () => {
    let scope: string | undefined
    const intent = () => async (request: Request) => {
      scope = Scope.get(request)
      return { challenge: new Response(null, { status: 402 }), status: 402 as const }
    }
    const app = new Elysia().guard({ beforeHandle: payment(intent as any, {} as any) }, (app) =>
      app.get('/items/:id', () => 'unreachable'),
    )

    const server = await createServer(app)
    const response = await globalThis.fetch(`${server.url}/items/123`)

    expect(response.status).toBe(402)
    expect(scope).toBe('GET /items/:id')
    server.close()
  })

  test('short-circuits management responses', async () => {
    let handlerRan = false
    const intent = () => async () => ({
      status: 200 as const,
      withReceipt: () =>
        new Response(null, {
          headers: { 'Payment-Receipt': 'management-receipt' },
          status: 204,
        }),
    })

    const app = new Elysia().guard(payment(intent as any, {} as any), (app) =>
      app.get('/', () => {
        handlerRan = true
        return { data: 'content' }
      }),
    )

    const response = await app.handle(new Request('http://localhost/'))
    expect(response.status).toBe(204)
    expect(response.headers.get('Payment-Receipt')).toBe('management-receipt')
    expect(await response.text()).toBe('')
    expect(handlerRan).toBe(false)
  })

  test('copies transport-specific success headers', async () => {
    const intent = () => async () => ({
      status: 200 as const,
      withReceipt: (response?: Response) => {
        if (!response)
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        return new Response(response.body, {
          headers: {
            ...Object.fromEntries(response.headers),
            'PAYMENT-RESPONSE': 'x402-response',
          },
          status: response.status,
        })
      },
    })

    const app = new Elysia().guard(payment(intent as any, {} as any), (app) =>
      app.get('/', () => ({ data: 'content' })),
    )

    const response = await app.handle(new Request('http://localhost/'))
    expect(response.status).toBe(200)
    expect(response.headers.get('PAYMENT-RESPONSE')).toBe('x402-response')
    expect(await response.json()).toEqual({ data: 'content' })
  })

  test.each(['guard', 'onBeforeHandle'] as const)(
    'preserves receipts for legacy %s registration',
    async (registration) => {
      const intent = () => async () => ({
        status: 200 as const,
        withReceipt: (response?: Response) => {
          if (!response)
            throw Object.assign(new Error('withReceipt() requires a response argument'), {
              name: 'MissingReceiptResponseError',
            })
          return new Response(response.body, {
            headers: { ...Object.fromEntries(response.headers), 'Payment-Receipt': 'paid' },
            status: response.status,
          })
        },
      })
      const hook = payment(intent as any, {} as any)
      const app =
        registration === 'guard'
          ? new Elysia().guard({ beforeHandle: hook }, (app) => app.get('/', () => 'content'))
          : new Elysia().onBeforeHandle(hook).get('/', () => 'content')

      const response = await app.handle(new Request('http://localhost/'))
      expect(response.headers.get('Payment-Receipt')).toBe('paid')
      expect(await response.text()).toBe('content')
    },
  )

  test.each(['guard', 'onBeforeHandle'] as const)(
    'fails closed for SSE with legacy %s registration',
    async (registration) => {
      let handlerRan = false
      const intent = () => async () => ({
        _supportsStreamingReceipts: true,
        status: 200 as const,
        withReceipt: (response?: Response) => {
          if (!response)
            throw Object.assign(new Error('withReceipt() requires a response argument'), {
              name: 'MissingReceiptResponseError',
            })
          return new Response('metered')
        },
      })
      const hook = payment(intent as any, {} as any)
      const app =
        registration === 'guard'
          ? new Elysia().guard({ beforeHandle: hook }, (app) =>
              app.get('/', () => {
                handlerRan = true
                return 'unmetered content'
              }),
            )
          : new Elysia().onBeforeHandle(hook).get('/', () => {
              handlerRan = true
              return 'unmetered content'
            })

      const response = await app.handle(new Request('http://localhost/'))
      expect(response.status).toBe(500)
      expect(await response.text()).toContain('paired beforeHandle and afterHandle')
      expect(handlerRan).toBe(false)
    },
  )

  test('preserves async iterable bodies for HTTP receipt transports', async () => {
    const intent = () => async () => ({
      status: 200 as const,
      withReceipt: (response?: Response) => {
        if (!response)
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        return new Response(response.body, {
          headers: { 'Payment-Receipt': 'http-receipt' },
        })
      },
    })
    const app = new Elysia().guard(payment(intent as any, {} as any), (app) =>
      app.get('/', async function* () {
        yield 'original stream'
      }),
    )

    const response = await app.handle(new Request('http://localhost/'))
    expect(response.headers.get('Payment-Receipt')).toBe('http-receipt')
    const chunk = await response.body!.getReader().read()
    expect(chunk.value).toBe('original stream')
  })

  test('preserves the receipt when a paid route throws', async () => {
    const intent = () => async () => ({
      status: 200 as const,
      withReceipt: (response?: Response) => {
        if (!response)
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        return new Response(response.body, {
          headers: { ...Object.fromEntries(response.headers), 'Payment-Receipt': 'paid' },
          status: response.status,
        })
      },
    })
    const app = new Elysia().guard(payment(intent as any, {} as any), (app) =>
      app.get('/', () => {
        throw new Error('route failed')
      }),
    )

    const response = await app.handle(new Request('http://localhost/'))
    expect(response.status).toBe(500)
    expect(response.headers.get('Payment-Receipt')).toBe('paid')
  })

  test('preserves the receipt when response mapping throws', async () => {
    const intent = () => async () => ({
      status: 200 as const,
      withReceipt: (response?: Response) => {
        if (!response)
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        return new Response(response.body, {
          headers: { ...Object.fromEntries(response.headers), 'Payment-Receipt': 'paid' },
          status: response.status,
        })
      },
    })
    const circular: Record<string, unknown> = {}
    circular.self = circular
    const app = new Elysia().guard(payment(intent as any, {} as any), (app) =>
      app.get('/', () => circular),
    )

    const response = await app.handle(new Request('http://localhost/'))

    expect(response.status).toBe(500)
    expect(response.headers.get('Payment-Receipt')).toBe('paid')
  })

  test('wraps the actual route response for a custom streaming transport', async () => {
    let wrappedResponse: unknown
    const intent = () => async () => ({
      _transportName: 'custom-stream',
      _supportsStreamingReceipts: true,
      status: 200 as const,
      withReceipt: (response?: unknown) => {
        if (!response)
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        wrappedResponse = response
        return new Response('metered stream', {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      },
    })

    const app = new Elysia().guard(payment(intent as any, {} as any), (app) =>
      app.get('/', async function* () {
        yield 'original stream'
      }),
    )

    const response = await app.handle(new Request('http://localhost/'))
    expect(response.headers.get('Content-Type')).toContain('text/event-stream')
    expect(await response.text()).toBe('metered stream')
    expect(typeof (wrappedResponse as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe(
      'function',
    )
  })

  test('forwards an ordinary streaming callback to the receipt transport', async () => {
    let wrappedResponse: unknown
    const stream = () =>
      (async function* () {
        yield 'original stream'
      })()
    const intent = () => async () => ({
      _supportsStreamingReceipts: true,
      status: 200 as const,
      withReceipt: (response?: unknown) => {
        if (!response)
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        wrappedResponse = response
        return new Response('metered stream', {
          headers: { 'Content-Type': 'text/event-stream' },
        })
      },
    })
    const app = new Elysia().guard(payment(intent as any, {} as any), (app) =>
      app.get('/', () => stream),
    )

    const response = await app.handle(new Request('http://localhost/'))

    expect(await response.text()).toBe('metered stream')
    expect(wrappedResponse).toBe(stream)
  })

  test('wraps a Response exactly once', async () => {
    let wraps = 0
    const intent = () => async () => ({
      _supportsStreamingReceipts: true,
      status: 200 as const,
      withReceipt: (response?: Response) => {
        if (!response)
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        wraps++
        return new Response(response.body, {
          headers: { ...Object.fromEntries(response.headers), 'Payment-Receipt': 'paid' },
          status: response.status,
        })
      },
    })
    const app = new Elysia().guard(payment(intent as any, {} as any), (app) =>
      app.get('/', () => new Response('content')),
    )

    const response = await app.handle(new Request('http://localhost/'))

    expect(wraps).toBe(1)
    expect(response.headers.get('Payment-Receipt')).toBe('paid')
    expect(await response.text()).toBe('content')
  })

  test('wraps a non-streaming Response exactly once', async () => {
    let wraps = 0
    const intent = () => async () => ({
      status: 200 as const,
      withReceipt: (response?: Response) => {
        if (!response)
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        wraps++
        return new Response(response.body, {
          headers: { ...Object.fromEntries(response.headers), 'Payment-Receipt': 'paid' },
          status: response.status,
        })
      },
    })
    const app = new Elysia().guard(payment(intent as any, {} as any), (app) =>
      app.get('/', () => new Response('content')),
    )

    const response = await app.handle(new Request('http://localhost/'))

    expect(wraps).toBe(1)
    expect(response.headers.get('Payment-Receipt')).toBe('paid')
    expect(await response.text()).toBe('content')
  })

  test('returns a receipt-wrapping failure instead of unpaid route content', async () => {
    const intent = () => async () => ({
      status: 200 as const,
      withReceipt: (response?: Response) => {
        if (!response)
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        return new Response('payment required', { status: 402 })
      },
    })
    const app = new Elysia().guard(payment(intent as any, {} as any), (app) =>
      app.get('/', () => ({ data: 'unpaid content' })),
    )

    const response = await app.handle(new Request('http://localhost/'))

    expect(response.status).toBe(402)
    expect(await response.text()).toBe('payment required')
  })
})

function createChargeHarness(feePayer: boolean) {
  const mppx = Mppx.create({
    methods: [
      tempo_server.charge({
        chainId: client.chain.id,
        getClient: () => client,
        currency: asset,
        recipient: accounts[0].address,
        ...(feePayer ? { feePayer: true } : {}),
      }),
    ],
    secretKey,
  })

  const { fetch } = Mppx_client.create({
    polyfill: false,
    methods: [
      tempo_client.charge({
        account: accounts[1],
        getClient: () => client,
      }),
    ],
  })

  return { fetch, mppx }
}

describe('charge', () => {
  test('returns 402 when no credential', async () => {
    const { mppx } = createChargeHarness(false)

    const app = new Elysia().guard(mppx.charge({ amount: '1' }), (app) =>
      app.get('/', () => ({ fortune: 'You will be rich' })),
    )

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    server.close()
  })

  test('returns 200 with receipt on valid payment', async () => {
    const { fetch, mppx } = createChargeHarness(false)

    const app = new Elysia().guard(mppx.charge({ amount: '1' }), (app) =>
      app.get('/', () => ({ fortune: 'You will be rich' })),
    )

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ fortune: 'You will be rich' })

    const receipt = Receipt.fromResponse(response)
    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('tempo')

    server.close()
  })

  test('fee payer: returns 200 with receipt on valid payment', async () => {
    const { fetch, mppx } = createChargeHarness(true)

    const app = new Elysia().guard(mppx.charge({ amount: '1' }), (app) =>
      app.get('/', () => ({ fortune: 'You will be rich' })),
    )

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)
    expect(Receipt.fromResponse(response).status).toBe('success')

    server.close()
  })

  test('serves /openapi.json from discovery plugin', async () => {
    const { mppx } = createChargeHarness(false)

    const app = new Elysia().use(
      discovery(mppx, {
        info: { title: 'Elysia API', version: '1.0.0' },
        routes: [{ handler: mppx.charge({ amount: '1' }), method: 'get', path: '/' }],
      }),
    )

    const server = await createServer(app)
    const response = await globalThis.fetch(`${server.url}/openapi.json`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')

    const body = (await response.json()) as Record<string, any>
    expect(body.info).toEqual({ title: 'Elysia API', version: '1.0.0' })
    expect(body.paths['/'].get['x-payment-info'].offers[0]).toMatchObject({
      amount: '1000000',
      currency: asset,
      intent: 'charge',
      method: 'tempo',
    })

    server.close()
  })
})

describe('session', () => {
  function createSessionHarness(feePayer: boolean) {
    const mppx = Mppx.create({
      methods: [
        tempo_server.session({
          chainId: client.chain.id,
          getClient: () => client,
          account: accounts[0],
          currency: asset,
          ...(feePayer ? { feePayer: accounts[1] } : {}),
        } as any),
      ],
      secretKey,
    })

    const { fetch } = Mppx_client.create({
      polyfill: false,
      methods: [
        sessionIntent({
          account: accounts[2],
          maxDeposit: '10',
          getClient: () => client,
        }),
      ],
    })

    return { fetch, mppx }
  }

  beforeAll(async () => {
    await fundAccount({ address: accounts[1].address, token: Addresses.pathUsd })
    await fundAccount({ address: accounts[1].address, token: asset })
    await fundAccount({ address: accounts[2].address, token: Addresses.pathUsd })
    await fundAccount({ address: accounts[2].address, token: asset })
  })

  test('returns 402 when no credential', async () => {
    const { mppx } = createSessionHarness(false)

    const app = new Elysia().guard(
      mppx.session({ amount: '1', currency: asset, unitType: 'token' }),
      (app) => app.get('/', () => ({ data: 'streamed' })),
    )

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    server.close()
  })

  test('returns 200 with receipt on valid payment', async () => {
    const { fetch, mppx } = createSessionHarness(false)

    const app = new Elysia().guard(
      mppx.session({ amount: '1', currency: asset, unitType: 'token' }),
      (app) => app.get('/', () => ({ data: 'streamed' })),
    )

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ data: 'streamed' })

    const receipt = Receipt.fromResponse(response)
    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('tempo')

    server.close()
  })

  test('fee payer: returns 200 with receipt on valid payment', async () => {
    const { fetch, mppx } = createSessionHarness(true)

    const app = new Elysia().guard(
      mppx.session({ amount: '1', currency: asset, unitType: 'token' }),
      (app) => app.get('/', () => ({ data: 'streamed' })),
    )

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)
    expect(Receipt.fromResponse(response).status).toBe('success')

    server.close()
  })
})
