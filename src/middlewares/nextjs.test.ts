import * as http from 'node:http'

import { Receipt } from 'mppx'
import { Mppx as Mppx_client, session as sessionIntent, tempo as tempo_client } from 'mppx/client'
import { Mppx } from 'mppx/nextjs'
import { tempo as tempo_server } from 'mppx/server'
import type { Address } from 'viem'
import { Addresses } from 'viem/tempo'
import { beforeAll, describe, expect, test } from 'vp/test'
import { deployEscrow } from '~test/tempo/session.js'
import { accounts, asset, client, fundAccount } from '~test/tempo/viem.js'

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

const secretKey = 'test-secret-key'

describe('charge', () => {
  const mppx = Mppx.create({
    methods: [
      tempo_server.charge({
        getClient: () => client,
        currency: asset,
        recipient: accounts[0].address,
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

  test('returns 402 when no credential', async () => {
    const handler = mppx.charge({ amount: '1' })(() =>
      Response.json({ fortune: 'You will be rich' }),
    )

    const server = await createServer(handler)
    const response = await globalThis.fetch(server.url)
    expect(response.status).toBe(402)
    expect(response.headers.get('WWW-Authenticate')).toContain('Payment')

    server.close()
  })

  test('returns 200 with receipt on valid payment', async () => {
    const handler = mppx.charge({ amount: '1' })(() =>
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
      secretKey,
    })

    const handler = mppx.session({ amount: '1', unitType: 'token' })(() =>
      Response.json({ data: 'streamed' }),
    )

    const server = await createServer(handler)
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

    const handler = mppx.session({ amount: '1', unitType: 'token' })(() =>
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
