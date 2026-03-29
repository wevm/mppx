import { Receipt } from 'mppx'
import { Mppx as Mppx_client, tempo as tempo_client } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { afterEach, describe, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'
import { accounts, asset, client } from '~test/tempo/viem.js'

import * as ApiProxy from '../Proxy.js'
import { anthropic } from './anthropic.js'

const apiKey = 'sk-ant-test-fake-anthropic-key'
const secretKey = 'test-secret-key'

const mppx_server = Mppx_server.create({
  methods: [
    tempo_server({
      account: accounts[0],
      currency: asset,
      getClient: () => client,
    }),
  ],
  secretKey,
})

const mppx_client = Mppx_client.create({
  polyfill: false,
  methods: [
    tempo_client({
      account: accounts[1],
      getClient: () => client,
    }),
  ],
})

let proxyServer: Awaited<ReturnType<typeof Http.createServer>> | undefined
let upstreamServer: Awaited<ReturnType<typeof Http.createServer>> | undefined

afterEach(() => {
  proxyServer?.close()
  upstreamServer?.close()
})

describe('anthropic', () => {
  test('behavior: proxies POST /v1/messages with charge and injects x-api-key', async () => {
    upstreamServer = await Http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          headers: {
            'x-api-key': req.headers['x-api-key'],
          },
        }),
      )
    })

    const proxy = ApiProxy.create({
      services: [
        anthropic({
          apiKey,
          baseUrl: upstreamServer.url,
          routes: {
            'POST /v1/messages': mppx_server.charge({ amount: '1', decimals: 6 }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await mppx_client.fetch(`${proxyServer.url}/anthropic/v1/messages`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'claude-3-opus-20240229', max_tokens: 1, messages: [] }),
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { headers: { 'x-api-key': string } }
    expect(body.headers['x-api-key']).toBe(apiKey)

    const receipt = Receipt.fromResponse(res)
    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('tempo')
  })

  test('behavior: returns 402 without credential', async () => {
    upstreamServer = await Http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })

    const proxy = ApiProxy.create({
      services: [
        anthropic({
          apiKey,
          baseUrl: upstreamServer.url,
          routes: {
            'POST /v1/messages': mppx_server.charge({ amount: '1', decimals: 6 }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/anthropic/v1/messages`, {
      method: 'POST',
    })
    expect(res.status).toBe(402)
    expect(res.headers.get('WWW-Authenticate')).toContain('Payment')
  })

  test('behavior: returns 404 for unmatched route', async () => {
    upstreamServer = await Http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end('{}')
    })

    const proxy = ApiProxy.create({
      services: [
        anthropic({
          apiKey,
          baseUrl: upstreamServer.url,
          routes: {
            'POST /v1/messages': mppx_server.charge({ amount: '1', decimals: 6 }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/anthropic/v1/unknown`)
    expect(res.status).toBe(404)
  })
})
