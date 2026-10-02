import express from 'express'
import { Receipt } from 'mppx'
import { Mppx as Mppx_client, session as sessionIntent, tempo as tempo_client } from 'mppx/client'
import { Mppx, discovery, payment } from 'mppx/express'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { Addresses } from 'viem/tempo'
import { beforeAll, describe, expect, test, vi } from 'vp/test'
import * as Http from '~test/Http.js'
import { accounts, asset, client, fundAccount } from '~test/tempo/viem.js'

import * as Scope from '../server/internal/scope.js'

function createServer(app: express.Express) {
  return new Promise<Http.TestServer>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number }
      resolve(Http.wrapServer(server, { port, url: `http://localhost:${port}` }))
    })
  })
}

const secretKey = 'test-secret-key-test-secret-key-32'

function createChargeHarness(feePayer: boolean) {
  const mppx = Mppx.create({
    methods: [
      tempo_server({
        getClient: () => client,
        currency: asset,
        account: accounts[0],
        ...(feePayer ? { feePayer: true } : {}),
      }),
    ],
    secretKey,
  })

  const { fetch } = Mppx_client.create({
    polyfill: false,
    methods: [
      tempo_client({
        account: accounts[1],
        getClient: () => client,
      }),
    ],
  })

  return { fetch, mppx }
}

function createCoreChargeHarness(feePayer: boolean) {
  const mppx = Mppx_server.create({
    methods: [
      tempo_server({
        getClient: () => client,
        currency: asset,
        account: accounts[0],
        ...(feePayer ? { feePayer: true } : {}),
      }),
    ],
    secretKey,
  })

  const { fetch } = Mppx_client.create({
    polyfill: false,
    methods: [
      tempo_client({
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

    const app = express()
    app.get('/', mppx.charge({ amount: '1' }), (_req, res) => {
      res.json({ fortune: 'You will be rich' })
    })

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    server.close()
  })

  test('returns 200 with receipt on valid payment', async () => {
    const { fetch, mppx } = createChargeHarness(false)

    const app = express()
    app.get('/', mppx.charge({ amount: '1' }), (_req, res) => {
      res.json({ fortune: 'You will be rich' })
    })

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ fortune: 'You will be rich' })

    const receiptHeader = response.headers.get('Payment-Receipt')
    expect(receiptHeader).toBeTruthy()

    const receipt = Receipt.fromResponse(response)
    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('tempo')

    server.close()
  })

  test('fee payer: returns 200 with receipt on valid payment', async () => {
    const { fetch, mppx } = createChargeHarness(true)

    const app = express()
    app.get('/', mppx.charge({ amount: '1' }), (_req, res) => {
      res.json({ fortune: 'You will be rich' })
    })

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)
    expect(Receipt.fromResponse(response).status).toBe('success')

    server.close()
  })

  test('serves /openapi.json from a handler-derived route config', async () => {
    const { mppx } = createChargeHarness(false)

    const app = express()
    const pay = mppx.charge({ amount: '1' })
    app.get('/', pay, (_req, res) => {
      res.json({ fortune: 'You will be rich' })
    })
    discovery(app, mppx, {
      info: { title: 'Express API', version: '1.2.3' },
      routes: [{ handler: pay, method: 'get', path: '/' }],
    })

    const server = await createServer(app)
    const response = await globalThis.fetch(`${server.url}/openapi.json`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')

    const body = (await response.json()) as Record<string, any>
    expect(body.info).toEqual({ title: 'Express API', version: '1.2.3' })
    expect(body.paths['/'].get['x-payment-info'].offers[0]).toMatchObject({
      amount: '1000000',
      currency: asset,
      intent: 'charge',
      method: 'tempo',
    })

    server.close()
  })
})

describe('payment', () => {
  test('attaches the Express route template as payment scope', async () => {
    let scope: string | undefined
    const intent = () => async (request: Request) => {
      scope = Scope.get(request)
      return { challenge: new Response(null, { status: 402 }), status: 402 as const }
    }
    const app = express()
    app.get('/items/:id', payment(intent as any, {} as any))

    const server = await createServer(app)
    const response = await globalThis.fetch(`${server.url}/items/123`)

    expect(response.status).toBe(402)
    expect(scope).toBe('GET /items/:id')
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

    const app = express()
    app.get('/', payment(intent as any, {} as any), (_req, res) => {
      res.json({ data: 'content' })
    })

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(200)
    expect(response.headers.get('PAYMENT-RESPONSE')).toBe('x402-response')

    server.close()
  })

  test('cancels the receipt when a protected handler fails', async () => {
    const cancelReceipt = vi.fn(async () => undefined)
    const intent = () => async () => ({
      cancelReceipt,
      status: 200 as const,
      withReceipt: async (response?: Response) => {
        if (!response)
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        return response
      },
    })
    const app = express()
    app.get('/', payment(intent as any, {} as any), (_req, _res, next) => {
      next(new Error('route failed'))
    })
    app.use((_error: unknown, _req: express.Request, res: express.Response, _next: unknown) => {
      res.status(500).send('route failed')
    })

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)

    expect(response.status).toBe(500)
    await vi.waitFor(() => expect(cancelReceipt).toHaveBeenCalledOnce())
    server.close()
  })

  test('cancels a receipt when the response closes before verification completes', async () => {
    const cancelReceipt = vi.fn()
    const withReceipt = vi.fn(() => {
      throw Object.assign(new Error('withReceipt() requires a response argument'), {
        name: 'MissingReceiptResponseError',
      })
    })
    let finishVerification!: (result: unknown) => void
    const verification = new Promise((resolve) => {
      finishVerification = resolve
    })
    const intent = () => () => verification
    const handler = payment(intent as any, {} as any)
    const request = {
      body: undefined,
      get: () => 'test.example.com',
      headers: {},
      method: 'GET',
      originalUrl: '/',
      protocol: 'https',
    } as unknown as express.Request
    const listeners = new Map<string, () => void>()
    const response = {
      destroyed: false,
      json: vi.fn(),
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener)
        return response
      }),
    } as unknown as express.Response
    const next = vi.fn()

    const handled = handler(request, response, next)
    listeners.get('close')?.()
    finishVerification({ cancelReceipt, status: 200 as const, withReceipt })
    await handled

    await vi.waitFor(() => expect(cancelReceipt).toHaveBeenCalledOnce())
    expect(withReceipt).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  test('cancels a receipt when the response closes during its management probe', async () => {
    const cancelReceipt = vi.fn()
    let probeStarted!: () => void
    const started = new Promise<void>((resolve) => {
      probeStarted = resolve
    })
    let finishProbe!: (response: Response) => void
    const probe = new Promise<Response>((resolve) => {
      finishProbe = resolve
    })
    const intent = () => async () => ({
      cancelReceipt,
      status: 200 as const,
      withReceipt() {
        probeStarted()
        return probe
      },
    })
    const handler = payment(intent as any, {} as any)
    const request = {
      body: undefined,
      get: () => 'test.example.com',
      headers: {},
      method: 'GET',
      originalUrl: '/',
      protocol: 'https',
    } as unknown as express.Request
    const listeners = new Map<string, () => void>()
    const response = {
      destroyed: false,
      end: vi.fn(),
      json: vi.fn(),
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener)
        return response
      }),
      send: vi.fn(),
      setHeader: vi.fn(),
      status: vi.fn(() => response),
    } as unknown as express.Response
    const next = vi.fn()

    const handled = handler(request, response, next)
    await started
    listeners.get('close')?.()
    finishProbe(new Response(null, { status: 204 }))
    await handled

    await vi.waitFor(() => expect(cancelReceipt).toHaveBeenCalledOnce())
    expect(response.end).not.toHaveBeenCalled()
    expect(response.send).not.toHaveBeenCalled()
    expect(next).not.toHaveBeenCalled()
  })

  test('cancels a receipt when the management probe fails', async () => {
    const cancelReceipt = vi.fn()
    const intent = () => async () => ({
      cancelReceipt,
      status: 200 as const,
      withReceipt: async () => {
        throw new Error('probe failed')
      },
    })
    const handler = payment(intent as any, {} as any)
    const request = {
      body: undefined,
      get: () => 'test.example.com',
      headers: {},
      method: 'GET',
      originalUrl: '/',
      protocol: 'https',
    } as unknown as express.Request
    const response = {
      destroyed: false,
      once: vi.fn(() => response),
    } as unknown as express.Response

    await expect(handler(request, response, vi.fn())).rejects.toThrow('probe failed')
    expect(cancelReceipt).toHaveBeenCalledOnce()
  })

  test('forwards the response error when receipt cancellation also fails', async () => {
    const cancelReceipt = vi.fn(async () => {
      throw new Error('cleanup failed')
    })
    const intent = () => async () => ({
      cancelReceipt,
      status: 200 as const,
      async withReceipt(response?: Response) {
        if (!response)
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        throw new Error('response failed')
      },
    })
    const handler = payment(intent as any, {} as any)
    const request = {
      body: undefined,
      get: () => 'test.example.com',
      headers: {},
      method: 'GET',
      originalUrl: '/',
      protocol: 'https',
    } as unknown as express.Request
    const response = {
      json: vi.fn(),
      once: vi.fn(),
    } as unknown as express.Response
    const next = vi.fn()

    await handler(request, response, next)
    next.mockClear()
    response.json({ data: 'content' })

    await vi.waitFor(() =>
      expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'response failed' })),
    )
    expect(cancelReceipt).toHaveBeenCalledOnce()
  })

  test('retries response cleanup when finish cancellation fails before close', async () => {
    const cancelReceipt = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('cleanup failed'))
      .mockResolvedValue(undefined)
    const intent = () => async () => ({
      cancelReceipt,
      status: 200 as const,
      withReceipt(response?: Response) {
        if (!response)
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        return response
      },
    })
    const handler = payment(intent as any, {} as any)
    const request = {
      body: undefined,
      get: () => 'test.example.com',
      headers: {},
      method: 'GET',
      originalUrl: '/',
      protocol: 'https',
    } as unknown as express.Request
    const listeners = new Map<string, () => void>()
    const response = {
      json: vi.fn(),
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener)
        return response
      }),
    } as unknown as express.Response
    const next = vi.fn()

    await handler(request, response, next)
    listeners.get('finish')?.()
    listeners.get('close')?.()

    await vi.waitFor(() => expect(cancelReceipt).toHaveBeenCalledTimes(2))
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'cleanup failed' }))
  })

  test('retries response cleanup when synchronous finish cancellation fails before close', async () => {
    const cancelReceipt = vi
      .fn<() => void>()
      .mockImplementationOnce(() => {
        throw new Error('cleanup failed')
      })
      .mockImplementation(() => undefined)
    const intent = () => async () => ({
      cancelReceipt,
      status: 200 as const,
      withReceipt(response?: Response) {
        if (!response)
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        return response
      },
    })
    const handler = payment(intent as any, {} as any)
    const request = {
      body: undefined,
      get: () => 'test.example.com',
      headers: {},
      method: 'GET',
      originalUrl: '/',
      protocol: 'https',
    } as unknown as express.Request
    const listeners = new Map<string, () => void>()
    const response = {
      json: vi.fn(),
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener)
        return response
      }),
    } as unknown as express.Response
    const next = vi.fn()

    await handler(request, response, next)
    expect(() => listeners.get('finish')?.()).not.toThrow()
    listeners.get('close')?.()

    await vi.waitFor(() => expect(cancelReceipt).toHaveBeenCalledTimes(2))
    expect(next).toHaveBeenCalledWith(expect.objectContaining({ message: 'cleanup failed' }))
  })

  test('cancels a receipt when the response closes during finalization', async () => {
    const cancelReceipt = vi.fn()
    let finalizationStarted!: () => void
    const started = new Promise<void>((resolve) => {
      finalizationStarted = resolve
    })
    let finishFinalization!: (response: Response) => void
    const finalization = new Promise<Response>((resolve) => {
      finishFinalization = resolve
    })
    const intent = () => async () => ({
      cancelReceipt,
      status: 200 as const,
      withReceipt(response?: Response) {
        if (!response)
          throw Object.assign(new Error('withReceipt() requires a response argument'), {
            name: 'MissingReceiptResponseError',
          })
        finalizationStarted()
        return finalization
      },
    })
    const handler = payment(intent as any, {} as any)
    const request = {
      body: undefined,
      get: () => 'test.example.com',
      headers: {},
      method: 'GET',
      originalUrl: '/',
      protocol: 'https',
    } as unknown as express.Request
    const listeners = new Map<string, () => void>()
    const originalJson = vi.fn()
    const response = {
      json: originalJson,
      once: vi.fn((event: string, listener: () => void) => {
        listeners.set(event, listener)
        return response
      }),
    } as unknown as express.Response
    const next = vi.fn()

    await handler(request, response, next)
    response.json({ data: 'content' })
    await started
    listeners.get('close')?.()
    finishFinalization(Response.json({ data: 'content' }))

    await vi.waitFor(() => expect(cancelReceipt).toHaveBeenCalledOnce())
    expect(originalJson).not.toHaveBeenCalled()
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

    const app = express()
    app.get('/', mppx.session({ amount: '1', currency: asset, unitType: 'token' }), (_req, res) => {
      res.json({ data: 'streamed' })
    })

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    server.close()
  })

  test('returns 200 with receipt on valid payment', async () => {
    const { fetch, mppx } = createSessionHarness(false)

    const app = express()
    app.get('/', mppx.session({ amount: '1', currency: asset, unitType: 'token' }), (_req, res) => {
      res.json({ data: 'streamed' })
    })

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ data: 'streamed' })

    server.close()
  })

  test('fee payer: returns 200 with receipt on valid payment', async () => {
    const { fetch, mppx } = createSessionHarness(true)

    const app = express()
    app.get('/', mppx.session({ amount: '1', currency: asset, unitType: 'token' }), (_req, res) => {
      res.json({ data: 'streamed' })
    })

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)
    expect(Receipt.fromResponse(response).status).toBe('success')

    server.close()
  })
})

describe('payment', () => {
  test('short-circuits management responses', async () => {
    let handlerRan = false
    const managementResponse = new Response(null, {
      status: 204,
      headers: { 'Payment-Receipt': 'management-receipt' },
    })
    const intent = () => async () => ({
      status: 200 as const,
      withReceipt: async () => managementResponse,
    })

    const app = express()
    app.get('/', payment(intent as any, {} as any), (_req, res) => {
      handlerRan = true
      res.json({ data: 'content' })
    })

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(204)
    expect(response.headers.get('Payment-Receipt')).toBe('management-receipt')
    expect(await response.text()).toBe('')
    expect(handlerRan).toBe(false)

    server.close()
  })

  test('returns 402 when no credential', async () => {
    const { mppx } = createCoreChargeHarness(false)

    const app = express()
    app.get('/', payment(mppx.charge, { amount: '1' }), (_req, res) => {
      res.json({ fortune: 'You will be rich' })
    })

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    server.close()
  })

  test('returns 200 with receipt on valid payment', async () => {
    const { fetch, mppx } = createCoreChargeHarness(false)

    const app = express()
    app.get('/', payment(mppx.charge, { amount: '1' }), (_req, res) => {
      res.json({ fortune: 'You will be rich' })
    })

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ fortune: 'You will be rich' })

    const receiptHeader = response.headers.get('Payment-Receipt')
    expect(receiptHeader).toBeTruthy()

    const receipt = Receipt.fromResponse(response)
    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('tempo')

    server.close()
  })

  test('fee payer: returns 200 with receipt on valid payment', async () => {
    const { fetch, mppx } = createCoreChargeHarness(true)

    const app = express()
    app.get('/', payment(mppx.charge, { amount: '1' }), (_req, res) => {
      res.json({ fortune: 'You will be rich' })
    })

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)
    expect(Receipt.fromResponse(response).status).toBe('success')

    server.close()
  })
})
