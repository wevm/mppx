import express from 'express'
import { Receipt } from 'mppx'
import { Mppx as Mppx_client, session as sessionIntent, tempo as tempo_client } from 'mppx/client'
import { Mppx } from 'mppx/express'
import { tempo as tempo_server } from 'mppx/server'
import type { Address } from 'viem'
import { Addresses } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vitest'
import { deployEscrow } from '~test/tempo/stream.js'
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

describe('charge', () => {
  const mppx = Mppx.create({
    methods: [
      tempo_server({
        getClient: () => client,
        currency: asset,
        recipient: accounts[0].address,
      }),
    ],
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

  test('returns 402 when no credential', async () => {
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

describe('session', () => {
  let escrowContract: Address

  beforeAll(async () => {
    escrowContract = await deployEscrow()
    await fundAccount({ address: accounts[2].address, token: Addresses.pathUsd })
    await fundAccount({ address: accounts[2].address, token: asset })
  })

  test('returns 402 when no credential', async () => {
    const mppx = Mppx.create({
      methods: [
        tempo_server.session({
          getClient: () => client,
          recipient: accounts[0].address,
          currency: asset,
          escrowContract,
        }),
      ],
    })

    const app = express()
    app.get('/', mppx.session({ amount: '1', unitType: 'token' }), (_req, res) => {
      res.json({ data: 'streamed' })
    })

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    server.close()
  })

  test('returns 200 with receipt on valid payment', async () => {
    const mppx = Mppx.create({
      methods: [
        tempo_server.session({
          getClient: () => client,
          recipient: accounts[0].address,
          currency: asset,
          escrowContract,
          feePayer: accounts[0],
        }),
      ],
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

    const app = express()
    app.get('/', mppx.session({ amount: '1', unitType: 'token' }), (_req, res) => {
      res.json({ data: 'streamed' })
    })

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ data: 'streamed' })

    server.close()
  })
})
