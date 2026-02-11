import { serve } from '@hono/node-server'
import { Hono } from 'hono'
import { Receipt } from 'mpay'
import { Mpay as Mpay_client, session as sessionIntent, tempo as tempo_client } from 'mpay/client'
import { Mpay } from 'mpay/hono'
import { tempo as tempo_server } from 'mpay/server'
import type { Address } from 'viem'
import { Addresses } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vitest'
import { deployEscrow } from '~test/tempo/stream.js'
import { accounts, asset, client, fundAccount } from '~test/tempo/viem.js'

function createServer(app: Hono) {
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0 }, (info) => {
      resolve({
        url: `http://localhost:${info.port}`,
        close: () => server.close(),
      })
    })
  })
}

describe('charge', () => {
  const mpay = Mpay.create({
    methods: [
      tempo_server.charge({
        getClient: () => client,
        currency: asset,
        recipient: accounts[0].address,
      }),
    ],
  })

  const { fetch } = Mpay_client.create({
    polyfill: false,
    methods: [
      tempo_client.charge({
        account: accounts[1],
        getClient: () => client,
      }),
    ],
  })

  test('returns 402 when no credential', async () => {
    const app = new Hono()
    app.get('/', mpay.charge({ amount: '1' }), (c) => c.json({ fortune: 'You will be rich' }))

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    server.close()
  })

  test('returns 200 with receipt on valid payment', async () => {
    const app = new Hono()
    app.get('/', mpay.charge({ amount: '1' }), (c) => c.json({ fortune: 'You will be rich' }))

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
})

describe('session', () => {
  let escrowContract: Address

  beforeAll(async () => {
    escrowContract = await deployEscrow()
    await fundAccount({ address: accounts[2].address, token: Addresses.pathUsd })
    await fundAccount({ address: accounts[2].address, token: asset })
  })

  test('returns 402 when no credential', async () => {
    const mpay = Mpay.create({
      methods: [
        tempo_server.session({
          getClient: () => client,
          recipient: accounts[0].address,
          currency: asset,
          escrowContract,
        }),
      ],
    })

    const app = new Hono()
    app.get('/', mpay.session({ amount: '1', unitType: 'token' }), (c) =>
      c.json({ data: 'streamed' }),
    )

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    server.close()
  })

  test('returns 200 with receipt on valid payment', async () => {
    const mpay = Mpay.create({
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

    const { fetch } = Mpay_client.create({
      polyfill: false,
      methods: [
        sessionIntent({
          account: accounts[2],
          deposit: '10',
          getClient: () => client,
        }),
      ],
    })

    const app = new Hono()
    app.get('/', mpay.session({ amount: '1', unitType: 'token' }), (c) =>
      c.json({ data: 'streamed' }),
    )

    const server = await createServer(app)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ data: 'streamed' })

    server.close()
  })
})
