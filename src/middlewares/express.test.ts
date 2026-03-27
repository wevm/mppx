import express from 'express'
import { Receipt } from 'mppx'
import { Mppx as Mppx_client, session as sessionIntent, tempo as tempo_client } from 'mppx/client'
import { Mppx, discovery, payment } from 'mppx/express'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import type { Address } from 'viem'
import { Addresses } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vp/test'
import { deployEscrow } from '~test/tempo/session.js'
import { accounts, asset, client, fundAccount } from '~test/tempo/viem.js'

function createServer(app: express.Express) {
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const server = app.listen(0, () => {
      const { port } = server.address() as { port: number }
      resolve({
        url: `http://localhost:${port}`,
        close: () => server.close(),
      })
    })
  })
}

const secretKey = 'test-secret-key'
const paymentModes = [
  { feePayer: false, name: 'direct' },
  { feePayer: true, name: 'fee payer' },
] as const

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
  for (const mode of paymentModes) {
    describe(mode.name, () => {
      test('returns 402 when no credential', async () => {
        const { mppx } = createChargeHarness(mode.feePayer)

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
        const { fetch, mppx } = createChargeHarness(mode.feePayer)

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
    })
  }

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

  for (const mode of paymentModes) {
    describe(mode.name, () => {
      test('returns 402 when no credential', async () => {
        const { mppx } = createSessionHarness(mode.feePayer)

        const app = express()
        app.get(
          '/',
          mppx.session({ amount: '1', currency: asset, unitType: 'token' }),
          (_req, res) => {
            res.json({ data: 'streamed' })
          },
        )

        const server = await createServer(app)
        const response = await globalThis.fetch(server.url)
        expect(response.status).toBe(402)
        expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

        server.close()
      })

      test('returns 200 with receipt on valid payment', async () => {
        const { fetch, mppx } = createSessionHarness(mode.feePayer)

        const app = express()
        app.get(
          '/',
          mppx.session({ amount: '1', currency: asset, unitType: 'token' }),
          (_req, res) => {
            res.json({ data: 'streamed' })
          },
        )

        const server = await createServer(app)
        const response = await fetch(server.url)
        expect(response.status).toBe(200)

        const body = await response.json()
        expect(body).toEqual({ data: 'streamed' })

        server.close()
      })
    })
  }
})

describe('payment', () => {
  for (const mode of paymentModes) {
    describe(mode.name, () => {
      test('returns 402 when no credential', async () => {
        const { mppx } = createCoreChargeHarness(mode.feePayer)

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
        const { fetch, mppx } = createCoreChargeHarness(mode.feePayer)

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
    })
  }
})
