import * as Identity from 'mppx/identity'
import { expect, test, vi } from 'vp/test'

const header =
  (name: string, value: string): Identity.Prover['prove'] =>
  (request) => {
    const headers = new Headers(request.headers)
    headers.set(name, value)
    return new Request(request, { headers })
  }

test('runs in-scope provers in order with one frozen attempt context', async () => {
  const contexts: Identity.ProveContext[] = []
  const order: string[] = []
  const prover = (name: string, scope: Identity.Prover['scope']): Identity.Prover => ({
    scope,
    prove(request, context) {
      contexts.push(context)
      order.push(name)
      return header(`X-${name}`, context.nonce)(request, context)
    },
  })
  const client = Identity.Client.from([
    prover('first', '*'),
    prover('skipped', ['https://elsewhere.example']),
    prover('last', ['https://merchant.example']),
  ])
  const fetch = vi.fn(async () => new Response('ok'))
  const { request } = await client.send(fetch as never, new Request('https://merchant.example/a'))

  expect(order).toEqual(['first', 'last'])
  expect(contexts[0]).toBe(contexts[1])
  expect(Object.isFrozen(contexts[0])).toBe(true)
  expect(request.headers.get('X-first')).toBe(contexts[0]!.nonce)
  expect(request.headers.has('X-skipped')).toBe(false)
})

test('proved requests do not follow redirects; unproved requests are sent unchanged', async () => {
  const client = Identity.Client.from([
    { scope: ['https://merchant.example'], prove: header('X-Proof', 'p') },
  ])
  const seen: Request[] = []
  const fetch = vi.fn(async (request: Request) => {
    seen.push(request)
    return new Response('ok')
  })
  await client.send(fetch as never, new Request('https://merchant.example/a'))
  await client.send(
    fetch as never,
    new Request('https://merchant.example/b', { redirect: 'manual' }),
  )
  await client.send(fetch as never, new Request('https://elsewhere.example/c'))
  expect(seen.map((request) => [request.redirect, request.headers.get('X-Proof')])).toEqual([
    ['error', 'p'],
    ['manual', 'p'],
    ['follow', null],
  ])
})

test('resends a rejected request once when a prover asks, with a new context', async () => {
  const nonces: string[] = []
  const retry = vi.fn(async (response: Response) => (await response.json()).retry === true)
  const client = Identity.Client.from([
    {
      scope: '*',
      prove(request, context) {
        nonces.push(context.nonce)
        return request
      },
      retry,
    },
  ])
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ retry: true }, { status: 403 }))
    .mockResolvedValueOnce(new Response('ok'))
  const { response } = await client.send(
    fetch as never,
    new Request('https://merchant.example', { body: 'x', method: 'POST' }),
  )
  expect(await response.text()).toBe('ok')
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(retry).toHaveBeenCalledTimes(1)
  expect(new Set(nonces).size).toBe(2)
})

test('never resends a 402 or a paid attempt', async () => {
  const retry = vi.fn(() => true)
  const client = Identity.Client.from([{ scope: '*', prove: (request) => request, retry }])
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response(null, { status: 402 }))
    .mockResolvedValueOnce(new Response(null, { status: 403 }))
  await client.send(fetch as never, new Request('https://merchant.example'))
  await client.send(fetch as never, new Request('https://merchant.example'), {
    challenge: { id: 'paid' } as never,
  })
  expect(fetch).toHaveBeenCalledTimes(2)
  expect(retry).not.toHaveBeenCalled()
})

test('passes a 402 challenge only to provers in scope for its URL', async () => {
  const ran: string[] = []
  const prover = (name: string, scope: Identity.Prover['scope']): Identity.Prover => ({
    scope,
    prove: (request) => request,
    retry() {
      ran.push(name)
      return false
    },
  })
  const client = Identity.Client.from([prover('any', '*'), prover('scoped', ['https://a.example'])])
  await client.challenge(new Response(null, { status: 402 }), {}, 'https://b.example/x')
  await client.challenge(new Response(null, { status: 402 }), {}, 'https://a.example/x')
  expect(ran).toEqual(['any', 'any', 'scoped'])
})

test('rejects an empty prover list', () => {
  expect(() => Identity.Client.from([])).toThrow(
    'Mppx client identity must configure at least one prover.',
  )
})

test('retry callbacks read a copy, so a declined retry returns a readable response', async () => {
  const client = Identity.Client.from([
    {
      scope: '*',
      prove: (request) => request,
      retry: async (response) => (await response.json()).retry,
    },
    {
      scope: '*',
      prove: (request) => request,
      retry: async (response) => (await response.json()).retry,
    },
  ])
  const fetch = vi.fn(async () => Response.json({ retry: false }, { status: 403 }))
  const { response } = await client.send(fetch as never, new Request('https://merchant.example'))
  expect(await response.json()).toEqual({ retry: false })
  expect(fetch).toHaveBeenCalledTimes(1)
})

test('a header-only retry callback does not block the resend', async () => {
  const client = Identity.Client.from([
    {
      scope: '*',
      prove: (request) => request,
      retry: (response) => response.headers.has('X-Challenge'),
    },
  ])
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(new Response('denied', { headers: { 'X-Challenge': '1' }, status: 401 }))
    .mockResolvedValueOnce(new Response('ok'))
  const { response } = await client.send(fetch as never, new Request('https://merchant.example'))
  expect(await response.text()).toBe('ok')
})
