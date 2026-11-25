import { Method, z } from 'mppx'
import * as Identity from 'mppx/identity'
import { describe, expect, test } from 'vp/test'

import * as Mppx from '../server/Mppx.js'
import * as Proxy from './Proxy.js'
import * as Service from './Service.js'

describe('stripHeaders', () => {
  test('behavior: strips the listed headers in both directions', async () => {
    let forwarded: Headers | undefined
    const proxy = Proxy.create({
      fetch: async (input, init) => {
        forwarded = new Request(input, init).headers
        return new Response('ok', {
          headers: { 'Proof-Request': 'request', 'Proof-Result': 'error', 'X-Upstream': 'kept' },
        })
      },
      services: [
        Service.from('api', {
          baseUrl: 'https://upstream.example',
          routes: { 'GET /resource': true },
        }),
      ],
      stripHeaders: { request: ['Proof-Response'], response: ['proof-request', 'proof-result'] },
    })

    const response = await proxy.fetch(
      new Request('https://proxy.example/api/resource', {
        headers: { 'Proof-Response': 'proof', 'X-Client': 'kept' },
      }),
    )

    expect(response.status).toBe(200)
    expect(forwarded?.has('proof-response')).toBe(false)
    expect(forwarded?.get('x-client')).toBe('kept')
    expect(response.headers.has('proof-request')).toBe(false)
    expect(response.headers.has('proof-result')).toBe(false)
    expect(response.headers.get('x-upstream')).toBe('kept')
  })
})

describe('identity headers', () => {
  const method = Method.toServer(
    Method.from({
      name: 'mock',
      intent: 'charge',
      schema: {
        credential: { payload: z.object({ token: z.string() }) },
        request: z.object({ amount: z.string() }),
      },
    }),
    {
      async verify() {
        return {
          method: 'mock',
          reference: 'ref',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    },
  )
  const mppx = Mppx.create({
    methods: [method],
    realm: 'api.example.com',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  const check: Identity.PaymentCheck = {
    headers: { request: ['Proof-Response'], response: ['proof-request', 'proof-result'] },
    requires: [{ type: 'x401' }],
    verify: () => ({ status: 'valid', value: true }),
  }

  async function run(identity: Parameters<typeof mppx.charge>[0]['identity']) {
    let forwarded: Headers | undefined
    const proxy = Proxy.create({
      fetch: async (input, init) => {
        forwarded = new Request(input, init).headers
        return new Response('ok', {
          headers: { 'Proof-Request': 'request', 'Proof-Result': 'error', 'X-Upstream': 'kept' },
        })
      },
      services: [
        Service.from('api', {
          baseUrl: 'https://upstream.example',
          routes: {
            'GET /free': true,
            'GET /paid': mppx.charge({ amount: '1', identity }),
          },
        }),
      ],
    })
    const response = await proxy.fetch(
      new Request('https://proxy.example/api/free', {
        headers: { 'Proof-Response': 'proof', 'X-Client': 'kept' },
      }),
    )
    return { forwarded: forwarded!, response }
  }

  test('behavior: strips the headers a route payment check declares, with no proxy config', async () => {
    const { forwarded, response } = await run({ payment: check })
    expect(forwarded.has('proof-response')).toBe(false)
    expect(forwarded.get('x-client')).toBe('kept')
    expect(response.headers.has('proof-request')).toBe(false)
    expect(response.headers.has('proof-result')).toBe(false)
    expect(response.headers.get('x-upstream')).toBe('kept')
  })

  test('behavior: strips the headers of anyOf members', async () => {
    const verifier = (name: string): Identity.Verifier => ({
      headers: { request: [name] },
      verify: () => ({ status: 'valid', value: true }),
    })
    const { forwarded } = await run([
      Identity.anyOf(verifier('x-other'), verifier('proof-response')),
    ])
    expect(forwarded.has('proof-response')).toBe(false)
  })

  test('behavior: keeps the headers when no route declares them', async () => {
    const { forwarded, response } = await run(undefined)
    expect(forwarded.get('proof-response')).toBe('proof')
    expect(response.headers.get('proof-request')).toBe('request')
  })
})
