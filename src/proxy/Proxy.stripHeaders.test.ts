import { describe, expect, test } from 'vp/test'

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
