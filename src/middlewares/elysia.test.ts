import * as http from 'node:http'

import { Elysia } from 'elysia'
import { Receipt } from 'mppx'
import { Mppx as Mppx_client, session as sessionIntent, tempo as tempo_client } from 'mppx/client'
import { Mppx, discovery, payment } from 'mppx/elysia'
import { tempo as tempo_server } from 'mppx/server'
import { Addresses } from 'viem/tempo'
import { afterEach, beforeAll, describe, expect, test, vi } from 'vp/test'
import * as TestHttp from '~test/Http.js'
import { accounts, asset, client, fundAccount } from '~test/tempo/viem.js'

import * as Scope from '../server/internal/scope.js'
import * as MppxCore from '../server/Mppx.js'

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
  afterEach(() => vi.restoreAllMocks())

  test.each(['response', 'json', 'iterable'] as const)(
    'wraps the actual %s route response',
    async (kind) => {
      const wrap = vi.fn(async (response?: unknown) => {
        if (!response)
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        if (kind === 'iterable') {
          expect(typeof (response as AsyncIterable<string>)[Symbol.asyncIterator]).toBe('function')
          return new Response('metered', { headers: { 'Content-Type': 'text/event-stream' } })
        }
        const actual = response as Response
        expect(actual.status).toBe(kind === 'response' ? 201 : 200)
        expect(await actual.text()).toBe(kind === 'response' ? 'content' : '{"value":"content"}')
        return new Response('wrapped', { headers: { 'Payment-Receipt': 'paid' } })
      })
      vi.spyOn(MppxCore, 'supportsStreamingReceipts').mockReturnValue(true)
      const intent = () => async () => ({ status: 200 as const, withReceipt: wrap })
      const app = new Elysia().guard(payment(intent as any, {} as any), (app) =>
        app.get('/', () => {
          if (kind === 'response') return new Response('content', { status: 201 })
          if (kind === 'json') return { value: 'content' }
          return (async function* () {
            yield 'original'
          })()
        }),
      )
      const response = await app.handle(new Request('http://localhost/'))
      expect(await response.text()).toBe(kind === 'iterable' ? 'metered' : 'wrapped')
      expect(wrap).toHaveBeenCalledTimes(2)
    },
  )

  test.each(['guard', 'onBeforeHandle'] as const)(
    'rejects streaming with legacy %s registration',
    async (registration) => {
      vi.spyOn(MppxCore, 'supportsStreamingReceipts').mockReturnValue(true)
      const handler = vi.fn(() => 'unmetered')
      const intent = () => async () => ({
        status: 200 as const,
        withReceipt() {
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        },
      })
      const hook = payment(intent as any, {} as any)
      const app =
        registration === 'guard'
          ? new Elysia().guard({ beforeHandle: hook }, (app) => app.get('/', handler))
          : new Elysia().onBeforeHandle(hook).get('/', handler)
      const response = await app.handle(new Request('http://localhost/'))
      expect(response.status).toBe(500)
      expect(handler).not.toHaveBeenCalled()
    },
  )

  test('paired hooks short-circuit management responses', async () => {
    const handler = vi.fn(() => 'unreachable')
    const intent = () => async () => ({
      status: 200 as const,
      withReceipt: async () => new Response(null, { status: 204 }),
    })
    const app = new Elysia().guard(payment(intent as any, {} as any), (app) =>
      app.get('/', handler),
    )
    expect((await app.handle(new Request('http://localhost/'))).status).toBe(204)
    expect(handler).not.toHaveBeenCalled()
  })

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

  test('awaits the bodyless receipt probe before continuing to the handler', async () => {
    let handlerRan = false
    let releaseCharge!: () => void
    const chargeGate = new Promise<void>((resolve) => {
      releaseCharge = resolve
    })
    let chargeStarted!: () => void
    const started = new Promise<void>((resolve) => {
      chargeStarted = resolve
    })
    const intent = () => async () => ({
      status: 200 as const,
      async withReceipt(response?: Response) {
        if (!response)
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        expect(response.status).toBe(204)
        chargeStarted()
        await chargeGate
        return new Response(null, {
          headers: { 'Payment-Receipt': 'receipt' },
          status: 204,
        })
      },
    })
    const app = new Elysia().guard({ beforeHandle: payment(intent as any, {} as any) }, (app) =>
      app.get('/', () => {
        handlerRan = true
        return 'content'
      }),
    )

    const responsePromise = app.handle(new Request('http://localhost/'))
    await started
    expect(handlerRan).toBe(false)
    releaseCharge()
    const response = await responsePromise
    expect(handlerRan).toBe(true)
    expect(response.headers.get('Payment-Receipt')).toBe('receipt')
  })

  test('short-circuits the handler when bodyless accounting returns 402', async () => {
    let handlerRan = false
    const intent = () => async () => ({
      status: 200 as const,
      async withReceipt(response?: Response) {
        if (!response)
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        return new Response('payment required', {
          headers: { 'WWW-Authenticate': 'Payment test' },
          status: 402,
        })
      },
    })
    const app = new Elysia().guard({ beforeHandle: payment(intent as any, {} as any) }, (app) =>
      app.get('/', () => {
        handlerRan = true
        return 'content'
      }),
    )

    const response = await app.handle(new Request('http://localhost/'))
    expect(response.status).toBe(402)
    expect(handlerRan).toBe(false)
  })

  test('short-circuits management responses', async () => {
    let handlerRan = false
    const intent = () => async () => ({
      status: 200 as const,
      withReceipt: async () =>
        new Response(null, {
          headers: { 'Payment-Receipt': 'management-receipt' },
          status: 204,
        }),
    })

    const app = new Elysia().guard({ beforeHandle: payment(intent as any, {} as any) }, (app) =>
      app.get('/', () => {
        handlerRan = true
        return { data: 'content' }
      }),
    )

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(204)
    expect(response.headers.get('Payment-Receipt')).toBe('management-receipt')
    expect(await response.text()).toBe('')
    expect(handlerRan).toBe(false)

    server.close()
  })

  test('copies transport-specific success headers', async () => {
    const intent = () => async () => ({
      status: 200 as const,
      withReceipt: async (response?: Response) =>
        new Response(response?.body ?? null, {
          headers: {
            ...(response ? Object.fromEntries(response.headers) : {}),
            'PAYMENT-RESPONSE': 'x402-response',
          },
          status: response?.status ?? 200,
        }),
    })

    const app = new Elysia().guard({ beforeHandle: payment(intent as any, {} as any) }, (app) =>
      app.get('/', () => ({ data: 'content' })),
    )

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(200)
    expect(response.headers.get('PAYMENT-RESPONSE')).toBe('x402-response')

    server.close()
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

    const app = new Elysia().guard({ beforeHandle: mppx.charge({ amount: '1' }) }, (app) =>
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

    const app = new Elysia().guard({ beforeHandle: mppx.charge({ amount: '1' }) }, (app) =>
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

    const app = new Elysia().guard({ beforeHandle: mppx.charge({ amount: '1' }) }, (app) =>
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
      { beforeHandle: mppx.session({ amount: '1', currency: asset, unitType: 'token' }) },
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
      { beforeHandle: mppx.session({ amount: '1', currency: asset, unitType: 'token' }) },
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
      { beforeHandle: mppx.session({ amount: '1', currency: asset, unitType: 'token' }) },
      (app) => app.get('/', () => ({ data: 'streamed' })),
    )

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)
    expect(Receipt.fromResponse(response).status).toBe('success')

    server.close()
  })
})
