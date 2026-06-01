import { Receipt } from 'mppx'
import { Mppx as Mppx_client, tempo as tempo_client } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { afterEach, describe, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'
import { accounts, asset, client } from '~test/tempo/viem.js'

import * as ApiProxy from '../Proxy.js'
import { openai } from './openai.js'

const apiKey = process.env.VITE_OPENAI_API_KEY
if (!apiKey) console.warn('OPENAI_API_KEY not set — openai proxy tests will be skipped')

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

describe('openai', () => {
  test('security: strips caller-supplied OpenAI tenant headers before proxying', async () => {
    upstreamServer = await Http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(
        JSON.stringify({
          headers: {
            authorization: req.headers.authorization,
            organization: req.headers['openai-organization'],
            project: req.headers['openai-project'],
          },
        }),
      )
    })

    const proxy = ApiProxy.create({
      services: [
        openai({
          apiKey: 'sk-test',
          baseUrl: upstreamServer.url,
          routes: {
            'POST /v1/chat/completions': true,
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/openai/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'OpenAI-Organization': 'org_attacker',
        'OpenAI-Project': 'proj_attacker',
      },
      body: '{}',
    })
    expect(res.status).toBe(200)

    const body = (await res.json()) as {
      headers: {
        authorization: string
        organization?: string | string[] | undefined
        project?: string | string[] | undefined
      }
    }
    expect(body.headers.authorization).toBe('Bearer sk-test')
    expect(body.headers.organization).toBeUndefined()
    expect(body.headers.project).toBeUndefined()
  })
})

describe.skipIf(!apiKey)('openai', () => {
  test('behavior: proxies GET /v1/models with charge', async () => {
    const proxy = ApiProxy.create({
      services: [
        openai({
          apiKey: apiKey!,
          routes: {
            'GET /v1/models': mppx_server.charge({ amount: '1', decimals: 6 }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await mppx_client.fetch(`${proxyServer.url}/openai/v1/models`)
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
            'GET /v1/models': mppx_server.charge({ amount: '1', decimals: 6 }),
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
            'GET /v1/models': mppx_server.charge({ amount: '1', decimals: 6 }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/openai/v1/unknown`)
    expect(res.status).toBe(404)
  })
})
