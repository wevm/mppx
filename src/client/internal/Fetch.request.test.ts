import { describe, expect, test, vi } from 'vp/test'

import * as Challenge from '../../Challenge.js'
import * as Fetch from './Fetch.js'

const url = 'https://api.example.com/jobs'
const body = JSON.stringify({ job: 'compute' })

/** Records native requests without opening connections or preparing real payments. */
function setup(challengeUrls: readonly string[], finalResponse = new Response('OK')) {
  const requests: Request[] = []
  const bodies: string[] = []
  const createCredential = vi.fn(async () => 'credential')
  const fetch = Fetch.from({
    methods: [{ name: 'test', intent: 'charge', createCredential }],
    fetch: async (input, init) => {
      const request = new Request(input, init)
      requests.push(request)
      bodies.push(await request.text())
      if (requests.length > challengeUrls.length) return finalResponse

      const response = new Response(null, {
        status: 402,
        headers: {
          'WWW-Authenticate': Challenge.serialize({
            id: `challenge-${requests.length}`,
            realm: 'api.example.com',
            method: 'test',
            intent: 'charge',
            request: {},
          }),
        },
      })
      Object.defineProperty(response, 'url', { value: challengeUrls[requests.length - 1] })
      return response
    },
  })
  return { bodies, createCredential, fetch, requests }
}

describe('Fetch.from: Request payment retries', () => {
  test.each([
    { method: 'POST', responseUrl: url },
    { method: 'PUT', responseUrl: url },
    { method: 'POST', responseUrl: `${url}/final` },
    { method: 'PUT', responseUrl: `${url}/final` },
    { method: 'POST', responseUrl: '' },
  ])(
    'preserves a Request $method body when the response URL is "$responseUrl"',
    async ({ method, responseUrl }) => {
      const { bodies, fetch, requests } = setup([responseUrl])
      const controller = new AbortController()
      const input = new Request(url, {
        body,
        cache: 'no-store',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Job': 'compute' },
        method,
        signal: controller.signal,
      })

      expect((await fetch(input)).status).toBe(200)
      expect(requests).toHaveLength(2)
      expect(bodies).toEqual([body, body])
      expect(requests[1]!.url).toBe(responseUrl || url)
      expect(requests[1]!.method).toBe(method)
      expect(requests[1]!.cache).toBe('no-store')
      expect(requests[1]!.credentials).toBe('include')
      expect(requests[1]!.headers.get('X-Job')).toBe('compute')
      expect(requests[1]!.headers.get('Authorization')).toBe('credential')
      expect(requests[1]!.redirect).toBe('manual')
      if (responseUrl) expect(input.bodyUsed).toBe(false)

      controller.abort()
      expect(requests[1]!.signal.aborted).toBe(true)
    },
  )

  test('replays the original Request body across multiple payment challenges', async () => {
    const { bodies, fetch, requests } = setup([url, `${url}/final`])

    expect((await fetch(new Request(url, { body, method: 'POST' }))).status).toBe(200)
    expect(requests.map((request) => request.method)).toEqual(['POST', 'POST', 'POST'])
    expect(bodies).toEqual([body, body, body])
    expect(requests[2]!.url).toBe(`${url}/final`)
  })

  test.each([url, `${url}/final`])(
    'preserves keepalive Request bodies at %s',
    async (responseUrl) => {
      const { bodies, fetch, requests } = setup([responseUrl])

      expect(
        (await fetch(new Request(url, { body, keepalive: true, method: 'POST' }))).status,
      ).toBe(200)
      expect(bodies).toEqual([body, body])
      expect(requests[1]!.keepalive).toBe(true)
      expect(requests[1]!.url).toBe(responseUrl)
    },
  )

  test('applies explicit init overrides to the retried Request', async () => {
    const { bodies, fetch, requests } = setup([`${url}/final`])
    const controller = new AbortController()
    const input = new Request(url, { body, method: 'POST' })

    await fetch(input, {
      body: 'override',
      credentials: 'omit',
      method: 'PATCH',
      signal: controller.signal,
    })

    expect(bodies).toEqual(['override', 'override'])
    expect(requests.map((request) => request.method)).toEqual(['PATCH', 'PATCH'])
    expect(requests[1]!.credentials).toBe('omit')
    controller.abort()
    expect(requests[1]!.signal.aborted).toBe(true)
  })

  test.each([
    { state: 'consumed', responseUrl: url },
    { state: 'locked', responseUrl: url },
    { state: 'consumed', responseUrl: `${url}/final` },
    { state: 'locked', responseUrl: `${url}/final` },
  ])('replaces a $state original body at $responseUrl', async ({ state, responseUrl }) => {
    const { bodies, createCredential, fetch, requests } = setup([responseUrl])
    const input = new Request(url, { body, method: 'POST' })
    const reader = state === 'locked' ? input.body!.getReader() : undefined
    if (state === 'consumed') await input.text()

    try {
      expect((await fetch(input, { body: 'replacement', method: 'POST' })).status).toBe(200)
      expect(bodies).toEqual(['replacement', 'replacement'])
      expect(requests.map((request) => request.method)).toEqual(['POST', 'POST'])
      expect(createCredential).toHaveBeenCalledOnce()
    } finally {
      reader?.releaseLock()
    }
  })

  test('preserves URL-plus-init requests and forces manual redirects on the paid retry', async () => {
    const { bodies, fetch, requests } = setup([`${url}/final`])

    await fetch(url, { body, method: 'POST', redirect: 'follow' })

    expect(bodies).toEqual([body, body])
    expect(requests[1]!.method).toBe('POST')
    expect(requests[1]!.url).toBe(`${url}/final`)
    expect(requests[0]!.redirect).toBe('follow')
    expect(requests[1]!.redirect).toBe('manual')
  })

  test('rejects a cross-origin response URL before creating a credential for a Request', async () => {
    const { createCredential, fetch, requests } = setup(['https://other.example.com/jobs'])

    await expect(fetch(new Request(url, { body, method: 'POST' }))).rejects.toThrow(
      'Refusing to send payment credential across redirect from https://api.example.com to https://other.example.com',
    )
    expect(requests).toHaveLength(1)
    expect(createCredential).not.toHaveBeenCalled()
    expect(requests[0]!.headers.has('Authorization')).toBe(false)
  })

  test('returns a paid redirect without following it or preparing another credential', async () => {
    const redirect = new Response(null, {
      status: 307,
      headers: { Location: 'https://other.example.com/jobs' },
    })
    const { createCredential, fetch, requests } = setup([url], redirect)

    expect(await fetch(new Request(url, { body, method: 'POST' }))).toBe(redirect)
    expect(requests).toHaveLength(2)
    expect(requests[1]!.redirect).toBe('manual')
    expect(createCredential).toHaveBeenCalledOnce()
  })
})
