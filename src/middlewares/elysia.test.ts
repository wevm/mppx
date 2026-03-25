import * as http from 'node:http'

import { Elysia } from 'elysia'
import { Receipt } from 'mppx'
import { Mppx as Mppx_client, tempo as tempo_client } from 'mppx/client'
import { Mppx, discovery } from 'mppx/elysia'
import { tempo as tempo_server } from 'mppx/server'
import { describe, expect, test } from 'vp/test'
import { accounts, asset, client } from '~test/tempo/viem.js'

function createServer(app: Elysia<any, any, any, any, any, any, any>) {
  return new Promise<{ url: string; close: () => void }>((resolve) => {
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

  test('serves /openapi.json from discovery plugin', async () => {
    const app = new Elysia()
      .use(discovery(mppx, {
        info: { title: 'Elysia API', version: '1.0.0' },
        routes: [{ handler: mppx.charge({ amount: '1' }), method: 'get', path: '/' }],
      }))

    const server = await createServer(app)
    const response = await globalThis.fetch(`${server.url}/openapi.json`)
    expect(response.status).toBe(200)
    expect(response.headers.get('cache-control')).toBe('public, max-age=300')

    const body = (await response.json()) as Record<string, any>
    expect(body.info).toEqual({ title: 'Elysia API', version: '1.0.0' })
    expect(body.paths['/'].get['x-payment-info']).toMatchObject({
      amount: '1000000',
      currency: asset,
      intent: 'charge',
      method: 'tempo',
    })

    server.close()
  })
})
