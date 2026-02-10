import express from 'express'
import { Receipt } from 'mpay'
import { tempo as tempo_client } from 'mpay/client'
import { Mpay } from 'mpay/express'
import { tempo as tempo_server } from 'mpay/server'
import type { Address } from 'viem'
import { Addresses } from 'viem/tempo'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { deployEscrow } from '~test/tempo/stream.js'
import { accounts, asset, client, fundAccount } from '~test/tempo/viem.js'
import * as Fetch from '../client/Fetch.js'
import type { ChannelState, ChannelStorage, SessionState } from '../tempo/stream/Storage.js'

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
  const mpay = Mpay.create({
    methods: [
      tempo_server.charge({
        getClient: () => client,
        currency: asset,
        recipient: accounts[0].address,
      }),
    ],
  })

  const fetch = Fetch.from({
    methods: [
      tempo_client.charge({
        account: accounts[1],
        getClient: () => client,
      }),
    ],
  })

  test('returns 402 when no credential', async () => {
    const app = express()
    app.get('/', mpay.charge({ amount: '1' }), (_req, res) => {
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
    app.get('/', mpay.charge({ amount: '1' }), (_req, res) => {
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

describe('stream', () => {
  let escrowContract: Address
  let storage: ChannelStorage

  beforeAll(async () => {
    escrowContract = await deployEscrow()
    await fundAccount({ address: accounts[2].address, token: Addresses.pathUsd })
    await fundAccount({ address: accounts[2].address, token: asset })
  })

  beforeEach(() => {
    storage = createMemoryStorage()
  })

  test('returns 402 when no credential', async () => {
    const mpay = Mpay.create({
      methods: [
        tempo_server.stream({
          storage,
          getClient: () => client,
          recipient: accounts[0].address,
          currency: asset,
          escrowContract,
        }),
      ],
    })

    const app = express()
    app.get('/', mpay.stream({ amount: '1', unitType: 'token' }), (_req, res) => {
      res.json({ data: 'streamed' })
    })

    const server = await createServer(app)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    server.close()
  })

  test('returns 200 with receipt on valid payment', async () => {
    const mpay = Mpay.create({
      methods: [
        tempo_server.stream({
          storage,
          getClient: () => client,
          recipient: accounts[0].address,
          currency: asset,
          escrowContract,
          feePayer: accounts[0],
        }),
      ],
    })

    const fetch = Fetch.from({
      methods: [
        tempo_client.stream({
          account: accounts[2],
          deposit: '10',
          getClient: () => client,
        }),
      ],
    })

    const app = express()
    app.get('/', mpay.stream({ amount: '1', unitType: 'token' }), (_req, res) => {
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

function createMemoryStorage(): ChannelStorage {
  const channels = new Map<string, ChannelState>()
  const sessions = new Map<string, SessionState>()
  return {
    async getChannel(channelId) {
      return channels.get(channelId) ?? null
    },
    async getSession(challengeId) {
      return sessions.get(challengeId) ?? null
    },
    async updateChannel(channelId, fn) {
      const current = channels.get(channelId) ?? null
      const result = fn(current)
      if (result) channels.set(channelId, result)
      else channels.delete(channelId)
      return result
    },
    async updateSession(challengeId, fn) {
      const current = sessions.get(challengeId) ?? null
      const result = fn(current)
      if (result) sessions.set(challengeId, result)
      else sessions.delete(challengeId)
      return result
    },
  }
}
