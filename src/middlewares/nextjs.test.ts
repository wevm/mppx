import * as http from 'node:http'
import type { Address } from 'viem'
import { Addresses } from 'viem/tempo'
import { beforeAll, beforeEach, describe, expect, test } from 'vitest'
import { deployEscrow } from '~test/tempo/stream.js'
import { accounts, asset, client, fundAccount } from '~test/tempo/viem.js'
import * as Fetch from '../client/Fetch.js'
import * as Receipt from '../Receipt.js'
import { charge as charge_client } from '../tempo/client/Charge.js'
import { stream as stream_client } from '../tempo/client/Stream.js'
import { charge as charge_server } from '../tempo/server/Charge.js'
import { stream as stream_server } from '../tempo/server/Stream.js'
import type { ChannelState, ChannelStorage, SessionState } from '../tempo/stream/Storage.js'
import { Mpay } from './nextjs.js'

function createServer(handler: (request: Request) => Promise<Response> | Response) {
  return new Promise<{ url: string; close: () => void }>((resolve) => {
    const server = http.createServer(async (req, res) => {
      const url = `http://localhost${req.url}`
      const headers = new Headers()
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        headers.append(req.rawHeaders[i]!, req.rawHeaders[i + 1]!)
      const request = new Request(url, { method: req.method!, headers })
      const response = await handler(request)
      res.writeHead(response.status, Object.fromEntries(response.headers))
      const body = await response.text()
      if (body) res.write(body)
      res.end()
    })
    server.listen(0, () => {
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
      charge_server({
        getClient: () => client,
        currency: asset,
        recipient: accounts[0].address,
      }),
    ],
  })

  const fetch = Fetch.from({
    methods: [
      charge_client({
        account: accounts[1],
        getClient: () => client,
      }),
    ],
  })

  test('returns 402 when no credential', async () => {
    const handler = mpay.charge({ amount: '1' })(() =>
      Response.json({ fortune: 'You will be rich' }),
    )

    const server = await createServer(handler)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    server.close()
  })

  test('returns 200 with receipt on valid payment', async () => {
    const handler = mpay.charge({ amount: '1' })(() =>
      Response.json({ fortune: 'You will be rich' }),
    )

    const server = await createServer(handler)
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
        stream_server({
          storage,
          getClient: () => client,
          recipient: accounts[0].address,
          currency: asset,
          escrowContract,
        }),
      ],
    })

    const handler = mpay.stream({ amount: '1', unitType: 'token' })(() =>
      Response.json({ data: 'streamed' }),
    )

    const server = await createServer(handler)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    server.close()
  })

  test('returns 200 with receipt on valid payment', async () => {
    const mpay = Mpay.create({
      methods: [
        stream_server({
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
        stream_client({
          account: accounts[2],
          deposit: '10',
          getClient: () => client,
        }),
      ],
    })

    const handler = mpay.stream({ amount: '1', unitType: 'token' })(() =>
      Response.json({ data: 'streamed' }),
    )

    const server = await createServer(handler)
    const response = await fetch(server.url)
    expect(response.status).toBe(200)

    const body = await response.json()
    expect(body).toEqual({ data: 'streamed' })

    const receipt = Receipt.fromResponse(response)
    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('tempo')

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
