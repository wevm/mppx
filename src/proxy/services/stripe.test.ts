import { Receipt } from 'mpay'
import { Mpay as Mpay_client, tempo as tempo_client } from 'mpay/client'
import { Mpay as Mpay_server, tempo as tempo_server } from 'mpay/server'
import { afterEach, describe, expect, test } from 'vitest'
import * as Http from '~test/Http.js'
import { accounts, asset, client } from '~test/tempo/viem.js'
import * as ApiProxy from '../Proxy.js'
import { stripe } from './stripe.js'

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

describe('stripe', () => {
  test('behavior: injects Basic auth header to upstream', async () => {
    const apiKey = 'sk_test_abc123'
    upstream = await createUpstream((req) =>
      Response.json({ auth: req.headers.get('authorization') }),
    )
    const proxy = ApiProxy.create({
      services: [
        stripe({
          apiKey,
          baseUrl: upstream.url,
          routes: { 'POST /v1/charges': mpay_server.charge({ amount: '1', decimals: 6 }) },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await mpay_client.fetch(`${proxyServer.url}/stripe/v1/charges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100 }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ auth: `Basic ${btoa(`${apiKey}:`)}` })

    const receipt = Receipt.fromResponse(res)
    expect(receipt.status).toBe('success')
    expect(receipt.method).toBe('tempo')
  })

  test('behavior: returns 404 for unmatched route', async () => {
    upstream = await createUpstream(() => Response.json({ ok: true }))
    const proxy = ApiProxy.create({
      services: [
        stripe({
          apiKey: 'sk_test_abc123',
          baseUrl: upstream.url,
          routes: { 'POST /v1/charges': mpay_server.charge({ amount: '1', decimals: 6 }) },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await fetch(`${proxyServer.url}/stripe/v1/unknown`)
    expect(res.status).toBe(404)
  })

  test('behavior: per-request apiKey override', async () => {
    const defaultKey = 'sk_test_default'
    const overrideKey = 'sk_test_override'
    upstream = await createUpstream((req) =>
      Response.json({ auth: req.headers.get('authorization') }),
    )
    const proxy = ApiProxy.create({
      services: [
        stripe({
          apiKey: defaultKey,
          baseUrl: upstream.url,
          routes: {
            'POST /v1/charges': {
              pay: mpay_server.charge({ amount: '1', decimals: 6 }),
              options: { apiKey: overrideKey },
            },
          },
        }),
      ],
    })
    proxyServer = await Http.createServer(proxy.listener)

    const res = await mpay_client.fetch(`${proxyServer.url}/stripe/v1/charges`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ amount: 100 }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ auth: `Basic ${btoa(`${overrideKey}:`)}` })
  })

  test('behavior: returns 402 without credential', async () => {
    upstream = await createUpstream(() => Response.json({ ok: true }))
    const proxy = ApiProxy.create({
      services: [
        stripe({
          apiKey: 'sk_test_abc123',
          baseUrl: upstream.url,
          routes: { 'POST /v1/charges': mpay_server.charge({ amount: '1', decimals: 6 }) },
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
})
