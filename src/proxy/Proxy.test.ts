import { Receipt } from 'mppx'
import { Mppx as Mppx_client, tempo as tempo_client } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { afterEach, describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'
import { accounts, asset, client } from '~test/tempo/viem.js'
import * as ApiProxy from './Proxy.js'
import * as Service from './Service.js'
import { anthropic } from './services/anthropic.js'
import { openai } from './services/openai.js'

const mppx_server = Mppx_server.create({
  methods: [
    tempo_server({
      account: accounts[0],
      currency: asset,
      getClient: () => client,
      feePayer: true,
    }),
  ],
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

let upstream: Awaited<ReturnType<typeof Http.createServer>> | undefined
let proxyServer: Awaited<ReturnType<typeof Http.createServer>> | undefined

afterEach(() => {
  upstream?.close()
  proxyServer?.close()
})

function createUpstream(handler: (req: Request) => Response | Promise<Response>) {
  return Http.createServer(async (req, res) => {
    const url = new URL(req.url!, 'http://localhost')
    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk)
    const body = chunks.length > 0 ? Buffer.concat(chunks) : undefined
    const request = new Request(url, {
      method: req.method!,
      headers: Object.entries(req.headers).reduce((h, [k, v]) => {
        if (v) h.set(k, Array.isArray(v) ? v.join(', ') : v)
        return h
      }, new Headers()),
      ...(body !== undefined && { body }),
    })
    const response = await handler(request)
    res.writeHead(response.status, Object.fromEntries(response.headers))
    const resBody = await response.text()
    if (resBody) res.write(resBody)
    res.end()
  })
}

describe('create', () => {
  test('behavior: GET /services returns service discovery', async () => {
    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: 'https://api.example.com',
          routes: {
            'GET /v1/models': true,
            'POST /v1/generate': mppx_server.charge({ amount: '1', description: 'Generate text' }),
            'POST /v1/stream': mppx_server.session({
              amount: '1',
              description: 'Stream text',
              unitType: 'token',
            }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/services`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchInlineSnapshot(`
      [
        {
          "baseUrl": "https://api.example.com",
          "id": "api",
          "routes": [
            {
              "method": "GET",
              "path": "/v1/models",
              "pattern": "GET /v1/models",
              "payment": null,
            },
            {
              "method": "POST",
              "path": "/v1/generate",
              "pattern": "POST /v1/generate",
              "payment": {
                "amount": "1000000",
                "currency": "0x20c0000000000000000000000000000000000001",
                "decimals": 6,
                "description": "Generate text",
                "intent": "charge",
                "method": "tempo",
                "recipient": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
              },
            },
            {
              "method": "POST",
              "path": "/v1/stream",
              "pattern": "POST /v1/stream",
              "payment": {
                "amount": "1000000",
                "currency": "0x20c0000000000000000000000000000000000001",
                "decimals": 6,
                "description": "Stream text",
                "intent": "session",
                "method": "tempo",
                "recipient": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
                "unitType": "token",
              },
            },
          ],
        },
      ]
    `)
  })

  test('behavior: GET /llms.txt returns markdown', async () => {
    const proxy = ApiProxy.create({
      services: [
        openai({
          apiKey: 'sk-test',
          routes: {
            'POST /v1/chat/completions': mppx_server.charge({
              amount: '0.05',
              description: 'Chat completion',
            }),
            'POST /v1/embeddings': mppx_server.charge({
              amount: '0.01',
              description: 'Generate embeddings',
            }),
          },
        }),
        anthropic({
          apiKey: 'sk-ant-test',
          routes: {
            'POST /v1/messages': mppx_server.charge({
              amount: '0.03',
              description: 'Send message',
            }),
            'POST /v1/messages/stream': mppx_server.session({
              amount: '0.01',
              description: 'Stream message',
              unitType: 'token',
            }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/llms.txt`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(await res.text()).toMatchInlineSnapshot(`
      "# API Proxy

      > Paid API proxy powered by [Machine Payments Protocol](https://mpp.tempo.xyz).

      For machine-readable service data, use \`GET /services\` (JSON).

      ## Services

      - [openai](https://api.openai.com): 2 paid
      - [anthropic](https://api.anthropic.com): 2 paid

      ## openai

      - \`POST /v1/chat/completions\`: charge — 50000 units — "Chat completion" — (currency: 0x20c0000000000000000000000000000000000001, decimals: 6)
      - \`POST /v1/embeddings\`: charge — 10000 units — "Generate embeddings" — (currency: 0x20c0000000000000000000000000000000000001, decimals: 6)

      ## anthropic

      - \`POST /v1/messages\`: charge — 30000 units — "Send message" — (currency: 0x20c0000000000000000000000000000000000001, decimals: 6)
      - \`POST /v1/messages/stream\`: session — 10000 units per token — "Stream message" — (currency: 0x20c0000000000000000000000000000000000001, decimals: 6)"
    `)
  })

  test('behavior: GET /services/:id returns single service', async () => {
    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: 'https://api.example.com',
          routes: {
            'GET /v1/models': true,
            'POST /v1/generate': mppx_server.charge({ amount: '1', description: 'Generate text' }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/services/api`)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchInlineSnapshot(`
      {
        "baseUrl": "https://api.example.com",
        "id": "api",
        "routes": [
          {
            "method": "GET",
            "path": "/v1/models",
            "pattern": "GET /v1/models",
            "payment": null,
          },
          {
            "method": "POST",
            "path": "/v1/generate",
            "pattern": "POST /v1/generate",
            "payment": {
              "amount": "1000000",
              "currency": "0x20c0000000000000000000000000000000000001",
              "decimals": 6,
              "description": "Generate text",
              "intent": "charge",
              "method": "tempo",
              "recipient": "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266",
            },
          },
        ],
      }
    `)
  })

  test('behavior: GET /services/:id returns 404 for unknown', async () => {
    const proxy = ApiProxy.create({ services: [] })
    proxyServer = await Http.createServer(proxy.listener)
    const res = await fetch(`${proxyServer.url}/services/unknown`)
    expect(res.status).toBe(404)
  })

  test('behavior: returns 404 for unknown service', async () => {
    const proxy = ApiProxy.create({ services: [] })
    proxyServer = await Http.createServer(proxy.listener)
    const res = await fetch(`${proxyServer.url}/unknown/path`)
    expect(res.status).toBe(404)
  })

  test('behavior: returns 404 for unmatched route', async () => {
    upstream = await createUpstream(() => Response.json({ ok: true }))
    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: upstream.url,
          routes: { 'GET /v1/known': true },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)
    const res = await fetch(`${proxyServer.url}/api/v1/unknown`)
    expect(res.status).toBe(404)
  })

  test('behavior: returns 404 for empty path', async () => {
    const proxy = ApiProxy.create({ services: [] })
    proxyServer = await Http.createServer(proxy.listener)
    const res = await fetch(`${proxyServer.url}/`)
    expect(res.status).toBe(404)
  })

  test('behavior: proxies upstream when endpoint is true', async () => {
    upstream = await createUpstream((req) => Response.json({ path: new URL(req.url).pathname }))
    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: upstream.url,
          routes: { 'GET /v1/status': true },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/api/v1/status`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ path: '/v1/status' })
  })

  test('behavior: returns 402 when no credential', async () => {
    upstream = await createUpstream(() => Response.json({ result: 'ok' }))
    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: upstream.url,
          routes: { 'GET /v1/generate': mppx_server.charge({ amount: '1', decimals: 6 }) },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/api/v1/generate`)
    expect(res.status).toBe(402)
    expect(res.headers.get('WWW-Authenticate')).toContain('Payment')
  })

  test('behavior: full 402 flow with mppx client', async () => {
    upstream = await createUpstream((req) => Response.json({ path: new URL(req.url).pathname }))
    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: upstream.url,
          bearer: 'sk-upstream-key',
          routes: { 'GET /v1/generate': mppx_server.charge({ amount: '1', decimals: 6 }) },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await mppx_client.fetch(`${proxyServer.url}/api/v1/generate`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ path: '/v1/generate' })

    const receipt = Receipt.fromResponse(res)
    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('tempo')
  })

  test('behavior: injects bearer token to upstream', async () => {
    upstream = await createUpstream((req) =>
      Response.json({ auth: req.headers.get('authorization') }),
    )
    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: upstream.url,
          bearer: 'sk-test-123',
          routes: { 'GET /v1/data': mppx_server.charge({ amount: '1', decimals: 6 }) },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await mppx_client.fetch(`${proxyServer.url}/api/v1/data`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ auth: 'Bearer sk-test-123' })
  })

  test('behavior: injects custom header to upstream', async () => {
    upstream = await createUpstream((req) => Response.json({ key: req.headers.get('x-api-key') }))
    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: upstream.url,
          headers: { 'X-Api-Key': 'secret' },
          routes: { 'GET /v1/data': mppx_server.charge({ amount: '1', decimals: 6 }) },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await mppx_client.fetch(`${proxyServer.url}/api/v1/data`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ key: 'secret' })
  })

  test('behavior: auth injected for free passthrough', async () => {
    upstream = await createUpstream((req) =>
      Response.json({ auth: req.headers.get('authorization') }),
    )
    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: upstream.url,
          bearer: 'sk-test-123',
          routes: { 'GET /v1/public': true },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/api/v1/public`)
    expect(await res.json()).toEqual({ auth: 'Bearer sk-test-123' })
  })

  test('behavior: strips incoming authorization from upstream', async () => {
    upstream = await createUpstream((req) =>
      Response.json({ auth: req.headers.get('authorization') }),
    )
    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: upstream.url,
          routes: { 'GET /v1/data': true },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/api/v1/data`, {
      headers: { Authorization: 'Payment credential=abc' },
    })
    expect(await res.json()).toEqual({ auth: null })
  })

  test('behavior: preserves safe headers', async () => {
    upstream = await createUpstream((req) =>
      Response.json({
        accept: req.headers.get('accept'),
      }),
    )
    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: upstream.url,
          routes: { 'GET /v1/data': true },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/api/v1/data`, {
      headers: { Accept: 'application/json' },
    })
    expect(await res.json()).toEqual({ accept: 'application/json' })
  })

  test('behavior: forwards request body to upstream', async () => {
    upstream = await createUpstream(async (req) => {
      const body = await req.text()
      return Response.json({ method: req.method, body: JSON.parse(body) })
    })
    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: upstream.url,
          routes: { 'POST /v1/generate': true },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/api/v1/generate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'gpt-4', prompt: 'hello' }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      method: 'POST',
      body: { model: 'gpt-4', prompt: 'hello' },
    })
  })

  test('behavior: forwards query params to upstream', async () => {
    upstream = await createUpstream((req) => Response.json({ search: new URL(req.url).search }))
    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: upstream.url,
          routes: { 'GET /v1/search': true },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/api/v1/search?q=hello&limit=10`)
    expect(await res.json()).toEqual({ search: '?q=hello&limit=10' })
  })
})
