import { Receipt } from 'mppx'
import { Mppx as Mppx_client, tempo as tempo_client } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { afterEach, describe, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'
import { accounts, asset, client } from '~test/tempo/viem.js'

import * as ApiProxy from '../Proxy.js'
import { stripe } from './stripe.js'

const apiKey = 'sk_test_fake_stripe_key'
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

describe('stripe', () => {
  test('behavior: proxies POST /v1/charges with charge and injects Basic auth', async () => {
    upstreamServer = await Http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          headers: {
            authorization: req.headers.authorization,
          },
        }),
      )
    })

    const proxy = ApiProxy.create({
      services: [
        stripe({
          apiKey,
          baseUrl: upstreamServer.url,
          routes: {
            'POST /v1/charges': mppx_server.charge({ amount: '1', decimals: 6 }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await mppx_client.fetch(`${proxyServer.url}/stripe/v1/charges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'amount=100&currency=usd',
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as { headers: { authorization: string } }
    expect(body.headers.authorization).toBe(`Basic ${btoa(`${apiKey}:`)}`)

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
        stripe({
          apiKey,
          baseUrl: upstreamServer.url,
          routes: {
            'POST /v1/charges': mppx_server.charge({ amount: '1', decimals: 6 }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/stripe/v1/charges`, {
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
        stripe({
          apiKey,
          baseUrl: upstreamServer.url,
          routes: {
            'POST /v1/charges': mppx_server.charge({ amount: '1', decimals: 6 }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/stripe/v1/unknown`)
    expect(res.status).toBe(404)
  })

  test('behavior: docsLlmsUrl returns route-specific URL', () => {
    const service = stripe({
      apiKey,
      routes: {
        'POST /v1/charges': mppx_server.charge({ amount: '1', decimals: 6 }),
      },
    })
    expect(service.docsLlmsUrl?.({ route: 'POST /v1/charges' })).toBe(
      'https://context7.com/websites/stripe/llms.txt?topic=POST%20%2Fv1%2Fcharges',
    )
  })

  test('behavior: docsLlmsUrl returns fallback URL without route', () => {
    const service = stripe({
      apiKey,
      routes: {
        'POST /v1/charges': mppx_server.charge({ amount: '1', decimals: 6 }),
      },
    })
    expect(service.docsLlmsUrl?.({ route: undefined })).toBe('https://docs.stripe.com/llms.txt')
  })
})
