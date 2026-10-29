import {
  Headers as FetchHeaders,
  MockAgent,
  Request as FetchRequest,
  Response as FetchResponse,
  fetch as nativeFetch,
} from 'undici'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vp/test'

import * as Challenge from '../../Challenge.js'
import * as Mppx from '../Mppx.js'
import * as Fetch from './Fetch.js'

const origin = 'https://api.example.com'
const redirectStatuses = [301, 302, 303, 307, 308] as const
const challenge = Challenge.serialize({
  id: 'offline',
  realm: 'api.example.com',
  method: 'test',
  intent: 'charge',
  request: {},
})

let agent: MockAgent

beforeEach(() => {
  // Use one Fetch implementation consistently. MockAgent intercepts its dispatcher;
  // redirects and Request handling still run through the real Fetch implementation.
  vi.stubGlobal('Request', FetchRequest)
  vi.stubGlobal('Response', FetchResponse)
  vi.stubGlobal('Headers', FetchHeaders)
  agent = new MockAgent()
  agent.disableNetConnect()
})

afterEach(async () => {
  await agent.close()
  vi.unstubAllGlobals()
})

function setup() {
  const createCredential = vi.fn(async () => 'credential')
  const methods = [{ name: 'test', intent: 'charge', createCredential }]
  const rawFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await nativeFetch(
      input as Parameters<typeof nativeFetch>[0],
      {
        ...init,
        dispatcher: agent,
      } as Parameters<typeof nativeFetch>[1],
    )
    // Undici and the DOM declarations differ in their iterator types.
    return response as unknown as Response
  }
  const fetch = Fetch.from({
    methods,
    fetch: rawFetch,
  })
  return { createCredential, fetch, methods, rawFetch }
}

describe('Fetch.from: native redirect handling without connections', () => {
  test.each(
    redirectStatuses.flatMap((status) => [
      { status, inputType: 'Request' },
      { status, inputType: 'URL' },
    ]),
  )(
    'does not guess the paid method after a POST $inputType follows $status',
    async ({ status, inputType }) => {
      const pool = agent.get(origin)
      const finalMethod = status === 307 || status === 308 ? 'POST' : 'GET'
      const finalRequest = vi.fn()
      pool.intercept({ path: '/start', method: 'POST' }).reply(status, '', {
        headers: { Location: '/final' },
      })
      pool.intercept({ path: '/final', method: finalMethod }).reply((options) => {
        finalRequest(options.method)
        return {
          statusCode: 402,
          data: '',
          responseOptions: { headers: { 'WWW-Authenticate': challenge } },
        }
      })
      const { createCredential, fetch } = setup()
      const input =
        inputType === 'Request'
          ? new Request(`${origin}/start`, { body: 'original', method: 'POST' })
          : `${origin}/start`

      await expect(
        fetch(input, inputType === 'URL' ? { body: 'original', method: 'POST' } : undefined),
      ).rejects.toThrow(
        'Cannot automatically pay a redirected POST request. Use prepareRequest() to preserve redirect semantics.',
      )
      expect(finalRequest).toHaveBeenCalledExactlyOnceWith(finalMethod)
      expect(createCredential).not.toHaveBeenCalled()
      agent.assertNoPendingInterceptors()
    },
  )

  test.each(['GET', 'HEAD'])(
    'pays a redirected %s Request with its final method',
    async (method) => {
      const pool = agent.get(origin)
      pool.intercept({ path: '/start', method }).reply(303, '', { headers: { Location: '/final' } })
      pool
        .intercept({ path: '/final', method })
        .reply(402, '', { headers: { 'WWW-Authenticate': challenge } })
      pool
        .intercept({ path: '/final', method, headers: { authorization: 'credential' } })
        .reply(200, 'OK')
      const { createCredential, fetch } = setup()

      expect((await fetch(new Request(`${origin}/start`, { method }))).status).toBe(200)
      expect(createCredential).toHaveBeenCalledOnce()
      agent.assertNoPendingInterceptors()
    },
  )

  test.each(redirectStatuses)(
    'preserves the final method and body through prepareRequest after %s',
    async (status) => {
      const pool = agent.get(origin)
      const finalMethod = status === 307 || status === 308 ? 'POST' : 'GET'
      const finalBody = finalMethod === 'POST' ? 'original' : ''
      const paidRequest = vi.fn()
      pool.intercept({ path: '/start', method: 'POST' }).reply(status, '', {
        headers: { Location: '/final' },
      })
      pool
        .intercept({ path: '/final', method: finalMethod })
        .reply(402, '', { headers: { 'WWW-Authenticate': challenge } })
      pool
        .intercept({
          path: '/final',
          method: finalMethod,
          headers: { authorization: 'credential' },
        })
        .reply((options) => {
          paidRequest(options.body)
          return { statusCode: 200, data: 'OK' }
        })
      const { createCredential, methods, rawFetch } = setup()
      const client = Mppx.create({ methods, fetch: rawFetch, polyfill: false })

      const prepared = await client.prepareRequest(
        new Request(`${origin}/start`, { body: 'original', method: 'POST' }),
      )

      expect(prepared.request.method).toBe(finalMethod)
      expect(prepared.redirects).toHaveLength(1)
      expect(prepared.redirects[0]?.status).toBe(status)
      expect(createCredential).not.toHaveBeenCalled()
      expect((await prepared.payment!.pay()).status).toBe(200)
      expect(paidRequest).toHaveBeenCalledExactlyOnceWith(
        finalBody ? new TextEncoder().encode(finalBody) : null,
      )
      expect(createCredential).toHaveBeenCalledOnce()
      agent.assertNoPendingInterceptors()
    },
  )

  test('checks the effective method supplied through init before paying a redirected request', async () => {
    const pool = agent.get(origin)
    pool
      .intercept({ path: '/start', method: 'POST' })
      .reply(303, '', { headers: { Location: '/final' } })
    pool
      .intercept({ path: '/final', method: 'GET' })
      .reply(402, '', { headers: { 'WWW-Authenticate': challenge } })
    const { createCredential, fetch } = setup()

    await expect(
      fetch(new Request(`${origin}/start`), { body: 'override', method: 'POST' }),
    ).rejects.toThrow('Cannot automatically pay a redirected POST request.')
    expect(createCredential).not.toHaveBeenCalled()
    agent.assertNoPendingInterceptors()
  })

  test('detects method ambiguity even when a redirect returns to the original URL', async () => {
    const pool = agent.get(origin)
    pool
      .intercept({ path: '/start', method: 'POST' })
      .reply(303, '', { headers: { Location: '/start' } })
    pool
      .intercept({ path: '/start', method: 'GET' })
      .reply(402, '', { headers: { 'WWW-Authenticate': challenge } })
    const { createCredential, fetch } = setup()

    await expect(
      fetch(new Request(`${origin}/start`, { body: 'original', method: 'POST' })),
    ).rejects.toThrow('Cannot automatically pay a redirected POST request.')
    expect(createCredential).not.toHaveBeenCalled()
    agent.assertNoPendingInterceptors()
  })

  test('rejects a cross-origin challenge before creating a credential', async () => {
    agent
      .get(origin)
      .intercept({ path: '/start', method: 'POST' })
      .reply(303, '', {
        headers: { Location: 'https://other.example.com/final' },
      })
    agent
      .get('https://other.example.com')
      .intercept({ path: '/final', method: 'GET' })
      .reply(402, '', {
        headers: { 'WWW-Authenticate': challenge },
      })
    const { createCredential, fetch } = setup()

    await expect(
      fetch(new Request(`${origin}/start`, { body: 'original', method: 'POST' })),
    ).rejects.toThrow(
      'Refusing to send payment credential across redirect from https://api.example.com to https://other.example.com',
    )
    expect(createCredential).not.toHaveBeenCalled()
    agent.assertNoPendingInterceptors()
  })

  test.each(redirectStatuses)(
    'returns a paid %s redirect without forwarding the credential',
    async (status) => {
      const pool = agent.get(origin)
      pool
        .intercept({ path: '/start', method: 'POST' })
        .reply(402, '', { headers: { 'WWW-Authenticate': challenge } })
      pool
        .intercept({ path: '/start', method: 'POST', headers: { authorization: 'credential' } })
        .reply(status, '', {
          headers: { Location: 'https://other.example.com/final' },
        })
      const { createCredential, fetch } = setup()

      expect(
        (await fetch(new Request(`${origin}/start`, { body: 'original', method: 'POST' }))).status,
      ).toBe(status)
      expect(createCredential).toHaveBeenCalledOnce()
      agent.assertNoPendingInterceptors()
    },
  )

  test.each([
    { error: 'Cannot automatically pay a no-cors request', init: { mode: 'no-cors' } },
    {
      error: 'Cannot automatically pay an only-if-cached request',
      init: { cache: 'only-if-cached', mode: 'same-origin' },
    },
  ] as const)(
    'rejects a Request whose retry cannot carry a credential: $error',
    async ({ error, init }) => {
      agent
        .get(origin)
        .intercept({ path: '/start', method: 'GET' })
        .reply(402, '', { headers: { 'WWW-Authenticate': challenge } })
      const { createCredential, rawFetch } = setup()
      const request = new Request(`${origin}/start`, init)
      // Node has no HTTP cache or CORS: fetch the 402 without these modes.
      const fetch = Fetch.from({
        methods: [{ name: 'test', intent: 'charge', createCredential }],
        fetch: (input, init) => rawFetch(input instanceof Request ? input.url : input, init),
      })

      await expect(fetch(request)).rejects.toThrow(error)
      expect(createCredential).not.toHaveBeenCalled()
    },
  )

  test('does not create a credential for a Request aborted during challenge handling', async () => {
    agent
      .get(origin)
      .intercept({ path: '/start', method: 'GET' })
      .reply(402, '', { headers: { 'WWW-Authenticate': challenge } })
    const { createCredential, rawFetch } = setup()
    const controller = new AbortController()
    const fetch = Fetch.from({
      methods: [{ name: 'test', intent: 'charge', createCredential }],
      fetch: rawFetch,
      onChallenge: async (_challenge, { createCredential }) => {
        controller.abort(new Error('aborted by caller'))
        return createCredential()
      },
    })

    await expect(
      fetch(new Request(`${origin}/start`, { signal: controller.signal })),
    ).rejects.toThrow('aborted by caller')
    expect(createCredential).not.toHaveBeenCalled()
  })

  test('pays a navigation Request as a same-origin retry', async () => {
    const pool = agent.get(origin)
    pool
      .intercept({ path: '/start', method: 'GET' })
      .reply(303, '', { headers: { Location: '/final' } })
    pool
      .intercept({ path: '/final', method: 'GET' })
      .reply(402, '', { headers: { 'WWW-Authenticate': challenge } })
    pool
      .intercept({ path: '/final', method: 'GET', headers: { authorization: 'credential' } })
      .reply(200, 'OK')
    const { createCredential, fetch } = setup()
    const request = new Request(`${origin}/start`)
    // Only browsers create navigation requests.
    Object.defineProperty(request, 'mode', { value: 'navigate' })

    expect((await fetch(request)).status).toBe(200)
    expect(createCredential).toHaveBeenCalledOnce()
    agent.assertNoPendingInterceptors()
  })
})
