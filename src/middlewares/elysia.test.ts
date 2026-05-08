import * as http from 'node:http'

import { Elysia } from 'elysia'
import { Receipt } from 'mppx'
import { Mppx as Mppx_client, session as sessionIntent, tempo as tempo_client } from 'mppx/client'
import { Mppx, discovery, payment } from 'mppx/elysia'
import { tempo as tempo_server } from 'mppx/server'
import type { Address } from 'viem'
import { Addresses } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vp/test'
import * as TestHttp from '~test/Http.js'
import { deployEscrow } from '~test/tempo/session.js'
import { accounts, asset, client, fundAccount } from '~test/tempo/viem.js'

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

const secretKey = 'test-secret-key'

describe('payment', () => {
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
})

function createChargeHarness(feePayer: boolean) {
  const mppx = Mppx.create({
    methods: [
      tempo_server.charge({
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
  let escrowContract: Address

  function createSessionHarness(feePayer: boolean) {
    const mppx = Mppx.create({
      methods: [
        tempo_server.session({
          getClient: () => client,
          account: accounts[0],
          currency: asset,
          escrowContract,
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
          deposit: '10',
          getClient: () => client,
        }),
      ],
    })

    return { fetch, mppx }
  }

  beforeAll(async () => {
    escrowContract = await deployEscrow()
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
