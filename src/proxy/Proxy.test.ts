import { Challenge, Credential, Method, Receipt, z } from 'mppx'
import { Mppx as Mppx_client, tempo as tempo_client } from 'mppx/client'
import { Mppx as Mppx_server, tempo as tempo_server } from 'mppx/server'
import { afterEach, describe, expect, test } from 'vp/test'
import * as Http from '~test/Http.js'
import { accounts, asset, client } from '~test/tempo/viem.js'

import * as ApiProxy from './Proxy.js'
import * as Service from './Service.js'
import { anthropic } from './services/anthropic.js'
import { openai } from './services/openai.js'

const secretKey = 'test-secret-key'

const mppx_server = Mppx_server.create({
  methods: [
    tempo_server({
      account: accounts[0],
      currency: asset,
      getClient: () => client,
      feePayer: true,
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
  test('behavior: GET /openapi.json returns discovery JSON', async () => {
    const proxy = ApiProxy.create({
      categories: ['gateway'],
      docs: {
        apiReference: 'https://gateway.example.com/reference',
        homepage: 'https://gateway.example.com',
      },
      title: 'My AI Gateway',
      version: '2.0.0',
      services: [
        Service.from('api', {
          baseUrl: 'https://api.example.com',
          categories: ['compute'],
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

    const res = await fetch(`${proxyServer.url}/openapi.json`)
    expect(res.status).toBe(200)
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    const body = (await res.json()) as Record<string, any>
    expect(body.openapi).toBe('3.1.0')
    expect(body.info).toEqual({ title: 'My AI Gateway', version: '2.0.0' })
    expect(body['x-service-info']).toEqual({
      categories: ['gateway'],
      docs: {
        apiReference: 'https://gateway.example.com/reference',
        homepage: 'https://gateway.example.com',
        llms: '/llms.txt',
      },
    })
    expect(body.paths['/api/v1/models'].get.responses['200']).toEqual({
      description: 'Successful response',
    })
    expect(body.paths['/api/v1/generate'].post['x-payment-info']).toMatchObject({
      amount: '1000000',
      currency: asset,
      description: 'Generate text',
      intent: 'charge',
      method: 'tempo',
    })
    expect(body.paths['/api/v1/stream'].post['x-payment-info']).toMatchObject({
      amount: '1000000',
      currency: asset,
      description: 'Stream text',
      intent: 'session',
      method: 'tempo',
    })
  })

  test('behavior: GET /llms.txt returns text docs linked to OpenAPI discovery', async () => {
    const proxy = ApiProxy.create({
      title: 'My AI Gateway',
      description: 'A paid proxy for LLM and AI services.',
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
      "# My AI Gateway

      > A paid proxy for LLM and AI services.

      ## Services

      - OpenAI: Chat completions, embeddings, image generation, and audio transcription.
      - Anthropic: Claude language models for messages and completions.

      [OpenAPI discovery](/openapi.json)"
    `)
  })

  test('behavior: GET /openapi.json respects basePath', async () => {
    const proxy = ApiProxy.create({
      basePath: '/proxy',
      services: [
        Service.from('api', {
          baseUrl: 'https://api.example.com',
          routes: {
            'POST /v1/generate': mppx_server.charge({ amount: '1', description: 'Generate text' }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/proxy/openapi.json`)
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, any>
    expect(body.paths['/proxy/api/v1/generate'].post['x-payment-info']).toMatchObject({
      amount: '1000000',
      currency: asset,
      description: 'Generate text',
      intent: 'charge',
      method: 'tempo',
    })
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

  test('behavior: joins upstream base paths with request paths', async () => {
    upstream = await createUpstream((req) =>
      Response.json({
        path: new URL(req.url).pathname,
        search: new URL(req.url).search,
      }),
    )
    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: `${upstream.url}/prefix/`,
          routes: { 'GET /v1/status': true },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/api/v1/status?q=ok`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ path: '/prefix/v1/status', search: '?q=ok' })
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

  test('behavior: management POST falls back to paid route with different method', async () => {
    upstream = await createUpstream(() => Response.json({ ok: true }))
    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: upstream.url,
          routes: {
            // Registered as GET but management POSTs (e.g. session close)
            // should still reach this paid endpoint via fallback.
            'GET /v1/stream': mppx_server.charge({ amount: '1', decimals: 6 }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/api/v1/stream`, {
      method: 'POST',
      headers: { Authorization: 'x' },
    })
    // Should hit the paid endpoint and get a 402 challenge, not 404
    expect(res.status).toBe(402)
  })

  test('behavior: management POST uses credential method binding to disambiguate same-path paid routes', async () => {
    const alpha = Method.from({
      name: 'alpha',
      intent: 'charge',
      schema: {
        credential: { payload: z.object({ token: z.string() }) },
        request: z.object({ amount: z.string() }),
      },
    })
    const beta = Method.from({
      name: 'beta',
      intent: 'charge',
      schema: {
        credential: { payload: z.object({ token: z.string() }) },
        request: z.object({ amount: z.string() }),
      },
    })

    const handler = Mppx_server.create({
      methods: [
        Method.toServer(alpha, {
          async verify() {
            return Receipt.from({
              method: 'alpha',
              status: 'success',
              timestamp: new Date().toISOString(),
              reference: 'alpha-reference',
            })
          },
          respond() {
            return new Response(null, { status: 204 })
          },
        }),
        Method.toServer(beta, {
          async verify() {
            return Receipt.from({
              method: 'beta',
              status: 'success',
              timestamp: new Date().toISOString(),
              reference: 'beta-reference',
            })
          },
          respond() {
            return new Response(null, { status: 205 })
          },
        }),
      ],
      secretKey,
    })

    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: 'https://example.com',
          routes: {
            'GET /v1/stream': handler['alpha/charge']({ amount: '1' }),
            'PATCH /v1/stream': handler['beta/charge']({ amount: '1' }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const challengeResponse = await fetch(`${proxyServer.url}/api/v1/stream`)
    expect(challengeResponse.status).toBe(402)

    const challenge = Challenge.fromResponse(challengeResponse)
    const authorization = Credential.serialize(
      Credential.from({
        challenge,
        payload: { token: 'ok' },
      }),
    )

    const res = await fetch(`${proxyServer.url}/api/v1/stream`, {
      method: 'POST',
      headers: { Authorization: authorization },
    })

    expect(res.status).toBe(204)
  })

  test('behavior: exact-match management POST does not forward upstream', async () => {
    let upstreamRequests = 0
    upstream = await createUpstream(() => {
      upstreamRequests += 1
      return Response.json({ ok: true })
    })

    const method = Method.from({
      name: 'mock',
      intent: 'charge',
      schema: {
        credential: { payload: z.object({ token: z.string() }) },
        request: z.object({ amount: z.string() }),
      },
    })
    const handler = Mppx_server.create({
      methods: [
        Method.toServer(method, {
          async verify() {
            return Receipt.from({
              method: 'mock',
              status: 'success',
              timestamp: new Date().toISOString(),
              reference: 'mock-reference',
            })
          },
          respond() {
            return new Response(null, { status: 204 })
          },
        }),
      ],
      secretKey,
    })

    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: upstream.url,
          routes: {
            'POST /v1/stream': handler['mock/charge']({ amount: '1' }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const challengeResponse = await fetch(`${proxyServer.url}/api/v1/stream`, { method: 'POST' })
    expect(challengeResponse.status).toBe(402)

    const challenge = Challenge.fromResponse(challengeResponse)
    const authorization = Credential.serialize(
      Credential.from({
        challenge,
        payload: { token: 'ok' },
      }),
    )
    const res = await fetch(`${proxyServer.url}/api/v1/stream`, {
      method: 'POST',
      headers: { Authorization: authorization },
    })

    expect(res.status).toBe(204)
    expect(upstreamRequests).toBe(0)
  })

  test('behavior: paid GET fallback does not forward POST upstream', async () => {
    let upstreamRequests = 0
    upstream = await createUpstream(async (req) => {
      upstreamRequests += 1
      return Response.json({
        body: await req.json(),
        method: req.method,
      })
    })

    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: upstream.url,
          bearer: 'sk-upstream-key',
          routes: { 'GET /v1/messages': mppx_server.charge({ amount: '1', decimals: 6 }) },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const challengeResponse = await fetch(`${proxyServer.url}/api/v1/messages`)
    expect(challengeResponse.status).toBe(402)

    const authorization = await mppx_client.createCredential(challengeResponse)
    expect(Credential.extractPaymentScheme(authorization)).toBeTruthy()

    const res = await fetch(`${proxyServer.url}/api/v1/messages`, {
      method: 'POST',
      headers: {
        Authorization: authorization,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ prompt: 'hello' }),
    })

    expect(res.status).toBe(405)
    expect(upstreamRequests).toBe(0)
  })

  test('behavior: POST to unregistered method does not fall back to free GET route', async () => {
    upstream = await createUpstream(() => Response.json({ ok: true }))
    const proxy = ApiProxy.create({
      services: [
        Service.from('api', {
          baseUrl: upstream.url,
          routes: {
            // GET is free, but there is no POST handler
            'GET /v1beta/cachedContents': true,
            'POST /v1beta/models/:model': mppx_server.charge({
              amount: '1',
              decimals: 6,
            }),
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    // A POST with a bogus authorization header should NOT fall back
    // to the free GET route — it must return 404.
    const res = await fetch(`${proxyServer.url}/api/v1beta/cachedContents`, {
      method: 'POST',
      headers: {
        Authorization: 'x',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: 'models/gemini-2.0-flash-001', contents: [] }),
    })
    expect(res.status).toBe(404)
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
