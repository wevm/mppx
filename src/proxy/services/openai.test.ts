import { Receipt } from 'mpay'
import { Mpay as Mpay_client, tempo as tempo_client } from 'mpay/client'
import { Mpay as Mpay_server, tempo as tempo_server } from 'mpay/server'
import { afterEach, describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'
import { accounts, asset, client } from '~test/tempo/viem.js'
import * as ApiProxy from '../Proxy.js'
import { openai } from './openai.js'

const apiKey = process.env.VITE_OPENAI_API_KEY
if (!apiKey) console.warn('OPENAI_API_KEY not set — openai proxy tests will be skipped')

const mpay_server = Mpay_server.create({
  methods: [
    tempo_server({
      account: accounts[0],
      currency: asset,
      getClient: () => client,
    }),
  ],
})

const mpay_client = Mpay_client.create({
  polyfill: false,
  methods: [
    tempo_client({
      account: accounts[1],
      getClient: () => client,
    }),
  ],
})

let proxyServer: Awaited<ReturnType<typeof Http.createServer>> | undefined

afterEach(() => proxyServer?.close())

describe.skipIf(!apiKey)('openai', () => {
  test('behavior: proxies GET /v1/models with charge', async () => {
    const proxy = ApiProxy.create({
      services: [
        openai({
          apiKey: apiKey!,
          routes: {
            'GET /v1/models': mpay_server.charge({ amount: '1', decimals: 6 }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await mpay_client.fetch(`${proxyServer.url}/openai/v1/models`)
    expect(res.status).toBe(200)

    const body = (await res.json()) as { data: unknown[] }
    expect(body.data).toBeDefined()
    expect(Array.isArray(body.data)).toBe(true)

    const receipt = Receipt.fromResponse(res)
    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('tempo')
  })

  test('behavior: returns 402 without credential', async () => {
    const proxy = ApiProxy.create({
      services: [
        openai({
          apiKey: apiKey!,
          routes: {
            'GET /v1/models': mpay_server.charge({ amount: '1', decimals: 6 }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/openai/v1/models`)
    expect(res.status).toBe(402)
    expect(res.headers.get('WWW-Authenticate')).toContain('Payment')
  })

  test('behavior: returns 404 for unmatched route', async () => {
    const proxy = ApiProxy.create({
      services: [
        openai({
          apiKey: apiKey!,
          routes: {
            'GET /v1/models': mpay_server.charge({ amount: '1', decimals: 6 }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/openai/v1/unknown`)
    expect(res.status).toBe(404)
  })
})
