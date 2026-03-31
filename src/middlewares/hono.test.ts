import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Receipt } from 'mppx'
import { Mppx as Mppx_client, session as sessionIntent, tempo as tempo_client } from 'mppx/client'
import { Mppx, discovery } from 'mppx/hono'
import { tempo as tempo_server } from 'mppx/server'
import type { Address } from 'viem'
import { Addresses } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'
import { deployEscrow } from '~test/tempo/session.js'
import { accounts, asset, client, fundAccount } from '~test/tempo/viem.js'

function createServer(app: Hono) {
  return new Promise<Http.TestServer>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve(
        Http.wrapServer(server as unknown as import('node:http').Server, {
          port: info.port,
          url: `http://localhost:${info.port}`,
        }),
      )
    })
  })
}

const secretKey = 'test-secret-key'

function createChargeHarness(feePayer: boolean) {
  const mppx = Mppx.create({
    methods: [
      tempo_server.charge({
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

    const app = new Hono()
    app.get('/', mppx.charge({ amount: '1' }), (c) => c.json({ fortune: 'You will be rich' }))

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    server.close()
  })

  test('returns 200 with receipt on valid payment', async () => {
    const { fetch, mppx } = createChargeHarness(false)

    const app = new Hono()
    app.get('/', mppx.charge({ amount: '1' }), (c) => c.json({ fortune: 'You will be rich' }))

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

    const app = new Hono()
    app.get('/', mppx.charge({ amount: '1' }), (c) => c.json({ fortune: 'You will be rich' }))

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)
    expect(Receipt.fromResponse(response).status).toBe('success')

    server.close()
  })

  test('serves /openapi.json via auto discovery', async () => {
    const { mppx } = createChargeHarness(false)

    const app = new Hono()
    app.get('/', mppx.charge({ amount: '1' }), (c) => c.json({ fortune: 'You will be rich' }))
    discovery(app, mppx, { auto: true, info: { title: 'Auto API', version: '2.0.0' } })

    const server = await createServer(app)
    const response = await globalThis.fetch(`${server.url}/openapi.json`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')

    const body = (await response.json()) as Record<string, any>
    expect(body.info).toEqual({ title: 'Auto API', version: '2.0.0' })
    expect(body.paths['/'].get['x-payment-info']).toMatchObject({
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

    const app = new Hono()
    app.get('/', mppx.session({ amount: '1', currency: asset, unitType: 'token' }), (c) =>
      c.json({ data: 'streamed' }),
    )

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    server.close()
  })

  test('returns 200 with receipt on valid payment', async () => {
    const { fetch, mppx } = createSessionHarness(false)

    const app = new Hono()
    app.get('/', mppx.session({ amount: '1', currency: asset, unitType: 'token' }), (c) =>
      c.json({ data: 'streamed' }),
    )

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ data: 'streamed' })

    server.close()
  })

  test('fee payer: returns 200 with receipt on valid payment', async () => {
    const { fetch, mppx } = createSessionHarness(true)

    const app = new Hono()
    app.get('/', mppx.session({ amount: '1', currency: asset, unitType: 'token' }), (c) =>
      c.json({ data: 'streamed' }),
    )

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)
    expect(Receipt.fromResponse(response).status).toBe('success')

    server.close()
  })
})
