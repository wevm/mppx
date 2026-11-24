import { Challenge, Credential, Method, z } from 'mppx'
import { Mppx } from 'mppx/client'
import { expect, test, vi } from 'vp/test'

const mock = Method.from({
  name: 'mock',
  intent: 'charge',
  schema: {
    credential: { payload: z.object({ token: z.string() }) },
    request: z.object({ amount: z.string(), currency: z.string() }),
  },
})

const challenge = Challenge.from({
  id: 'challenge-id',
  intent: 'charge',
  method: 'mock',
  realm: 'example.test',
  request: { amount: '1', currency: 'USD' },
})

function setup(onChallenge: Parameters<typeof Mppx.create>[0]['onChallenge']) {
  const createCredential = vi.fn(async () =>
    Credential.serialize({ challenge, payload: { token: 'paid' } }),
  )
  const fetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) =>
    new Headers(init?.headers).has('Authorization')
      ? new Response('paid', { status: 200 })
      : new Response(null, {
          status: 402,
          headers: { 'WWW-Authenticate': Challenge.serialize(challenge) },
        }),
  )
  const mppx = Mppx.create({
    fetch: fetch as typeof globalThis.fetch,
    methods: [Method.toClient(mock, { createCredential })],
    onChallenge,
    polyfill: false,
  })
  return { createCredential, fetch, mppx }
}

test('onChallenge returning false declines: nothing is paid and the 402 is returned', async () => {
  const onChallenge = vi.fn(async () => false as const)
  const { createCredential, fetch, mppx } = setup(onChallenge)

  const response = await mppx.fetch('https://example.test/paid')

  expect(response.status).toBe(402)
  expect(onChallenge).toHaveBeenCalledWith(
    expect.objectContaining({ id: challenge.id }),
    expect.anything(),
  )
  expect(createCredential).not.toHaveBeenCalled()
  expect(fetch).toHaveBeenCalledTimes(1)
})

test('onChallenge returning undefined approves the default payment', async () => {
  const onChallenge = vi.fn(async () => undefined)
  const { createCredential, fetch, mppx } = setup(onChallenge)

  const response = await mppx.fetch('https://example.test/paid')

  expect(response.status).toBe(200)
  expect(onChallenge).toHaveBeenCalledTimes(1)
  expect(createCredential).toHaveBeenCalledTimes(1)
  expect(fetch).toHaveBeenCalledTimes(2)
})
