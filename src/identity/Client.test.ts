import { Challenge, Credential } from 'mppx'
import * as Identity from 'mppx/identity'
import { expect, test, vi } from 'vp/test'

const testChallenge = (id: string) =>
  Challenge.from({
    id,
    intent: 'charge',
    method: 'test',
    realm: 'merchant.example',
    request: { amount: '1' },
  })

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
  fetch.mockResolvedValueOnce(new Response(null, { status: 403 }))
  await client.send(
    fetch as never,
    new Request('https://merchant.example', { headers: { Authorization: 'Payment abc' } }),
  )
  fetch.mockResolvedValueOnce(new Response(null, { status: 403 }))
  await client.send(
    fetch as never,
    new Request('https://merchant.example', {
      headers: { Authorization: 'Bearer x, payment  abc' },
    }),
  )
  expect(fetch).toHaveBeenCalledTimes(4)
  expect(retry).not.toHaveBeenCalled()
})

test('passes a 402 challenge only to provers in scope for its URL', async () => {
  const ran: string[] = []
  const prover = (name: string, scope: Identity.Prover['scope']): Identity.Prover => ({
    scope,
    prove: (request) => request,
    prepare() {
      ran.push(name)
    },
  })
  const client = Identity.Client.from([prover('any', '*'), prover('scoped', ['https://a.example'])])
  const challenge = testChallenge('c')
  await client.challenge(new Response(null, { status: 402 }), { challenge }, 'https://b.example/x')
  await client.challenge(new Response(null, { status: 402 }), { challenge }, 'https://a.example/x')
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

test('rejects a prover scope that is not "*" or an array of origins', () => {
  expect(() =>
    Identity.Client.from([
      { scope: 'https://payments.example.com' as never, prove: (request) => request },
    ]),
  ).toThrow('Identity prover scope must be "*" or an array of origins.')
})

test('sends the request itself when it can never be resent', async () => {
  const seen: Request[] = []
  const fetch = vi.fn(async (request: Request) => {
    seen.push(request)
    return new Response('ok')
  })
  const out = new Request('https://elsewhere.example', { body: 'x', method: 'POST' })
  const outcome = await Identity.Client.from([
    { scope: ['https://merchant.example'], prove: header('X-Proof', 'p') },
  ]).send(fetch as never, out)
  expect(seen[0]).toBe(out)
  expect(outcome.request).toBe(out)
})

test("wrapFetch binds proofs to an attached Credential's Challenge, else to the context's", async () => {
  const seen: (string | undefined)[] = []
  const client = Identity.Client.from([
    {
      scope: '*',
      prove(request, context) {
        seen.push(context.challenge?.id)
        return request
      },
    },
  ])
  const fetch = Identity.Client.wrapFetch(vi.fn(async () => new Response('ok')) as never, client, {
    challenge: testChallenge('first'),
  })
  await fetch('https://merchant.example', {
    headers: {
      Authorization: Credential.serialize({ challenge: testChallenge('second'), payload: {} }),
    },
    method: 'POST',
  })
  await fetch('https://merchant.example', { method: 'POST' })
  expect(seen).toEqual(['second', 'first'])
})

test('challenge releases each unread copy after its prepare callback', async () => {
  let cancelled = 0
  const response = new Response(
    new ReadableStream({
      cancel() {
        cancelled++
      },
    }),
    { status: 402 },
  )
  const client = Identity.Client.from([
    { scope: '*', prove: (request) => request, prepare: () => {} },
  ])
  await client.challenge(response, { challenge: testChallenge('c') }, 'https://merchant.example')
  await response.body!.cancel()
  expect(cancelled).toBe(1)
})

test('never resends a request carrying an x402 credential', async () => {
  const retry = vi.fn(() => true)
  const client = Identity.Client.from([{ scope: '*', prove: (request) => request, retry }])
  for (const name of ['PAYMENT-SIGNATURE', 'X-PAYMENT']) {
    const fetch = vi.fn(async () => new Response('denied', { status: 403 }))
    await client.send(
      fetch as never,
      new Request('https://merchant.example', { headers: { [name]: 'signed' } }),
    )
    expect(fetch).toHaveBeenCalledTimes(1)
  }
  expect(retry).not.toHaveBeenCalled()
})

test('wrapFetch returns a 402 without a Payment challenge instead of throwing', async () => {
  const challenge = Challenge.from({
    id: 'first',
    intent: 'charge',
    method: 'test',
    realm: 'merchant.example',
    request: { amount: '1' },
  })
  const fetch = Identity.Client.wrapFetch(
    vi.fn(
      async () =>
        new Response(null, { status: 402, headers: { 'WWW-Authenticate': 'Payment broken' } }),
    ) as never,
    Identity.Client.from([{ scope: '*', prove: (request) => request, retry: () => false }]),
    { challenge },
  )
  const response = await fetch('https://merchant.example', { method: 'POST' })
  expect(response.status).toBe(402)
})

test('prepare runs only on 402s and retry only on other rejections', async () => {
  const prepare = vi.fn()
  const retry = vi.fn(() => false)
  const client = Identity.Client.from([{ scope: '*', prove: (request) => request, prepare, retry }])
  await client.send(
    async () => new Response(null, { status: 403 }),
    new Request('https://a.example'),
  )
  await client.challenge(
    new Response(null, { status: 402 }),
    { challenge: testChallenge('c') },
    'https://a.example',
  )
  expect(prepare).toHaveBeenCalledTimes(1)
  expect(retry).toHaveBeenCalledTimes(1)
})

test('wrapFetch preserves payment suppression through identity request conversion', async () => {
  const skipPayment = Symbol.for('mppx.fetch.skipPayment')
  const identity = Identity.Client.from([{ scope: '*', prove: header('X-Identity', 'proof') }])
  const send = vi.fn(async (_request: RequestInfo | URL, init?: RequestInit) => {
    expect((init as RequestInit & { [skipPayment]?: boolean })[skipPayment]).toBe(true)
    return new Response(null, { status: 402 })
  })
  const wrapped = Identity.Client.wrapFetch(send, identity)
  await wrapped('https://merchant.example', { [skipPayment]: true } as RequestInit)
  expect(send).toHaveBeenCalledOnce()
})

test('prepare receives the selected challenge and the Identity-Required requirements', async () => {
  const prepare = vi.fn()
  const client = Identity.Client.from([{ scope: '*', prove: (request) => request, prepare }])
  const challenge = testChallenge('c')
  await client.challenge(
    new Response(null, {
      headers: { 'Identity-Required': 'kyc;issuer="https://kyc.example", email, ("bad")' },
      status: 402,
    }),
    { challenge },
    'https://a.example',
  )
  const [, context] = prepare.mock.calls[0]!
  expect(context).toEqual({
    challenge,
    requirements: [{ type: 'kyc', issuer: 'https://kyc.example' }, { type: 'email' }],
  })
  expect(Object.isFrozen(context)).toBe(true)
  await client.challenge(
    new Response(null, { headers: { 'Identity-Required': '"unparsed' }, status: 402 }),
    { challenge },
    'https://a.example',
  )
  expect(prepare.mock.calls[1]![1].requirements).toEqual([])
})

test('a retry returning headers resends once with them set before the provers prove it', async () => {
  const signed: (string | null)[] = []
  const client = Identity.Client.from([
    {
      scope: '*',
      prove: (request) => request,
      retry: () => ({ 'X-Token': 'from-retry' }),
    },
    {
      scope: '*',
      // A signing prover listed last records what its signature would cover.
      prove: (request) => {
        signed.push(request.headers.get('X-Token'))
        return request
      },
    },
  ])
  const seen: Request[] = []
  const fetch = vi.fn(async (request: Request) => {
    seen.push(request)
    return seen.length === 1 ? new Response(null, { status: 401 }) : new Response('ok')
  })
  const { response } = await client.send(fetch as never, new Request('https://merchant.example'))
  expect(await response.text()).toBe('ok')
  expect(seen.map((request) => request.headers.get('X-Token'))).toEqual([null, 'from-retry'])
  expect(signed).toEqual([null, 'from-retry'])
})

test('combines same-named retry headers from several provers', async () => {
  const client = Identity.Client.from([
    { scope: '*', prove: (request) => request, retry: () => ({ 'X-Token': 'a' }) },
    { scope: '*', prove: (request) => request, retry: () => ({ 'X-Token': 'b' }) },
  ])
  const seen: (string | null)[] = []
  const fetch = vi.fn(async (request: Request) => {
    seen.push(request.headers.get('X-Token'))
    return seen.length === 1 ? new Response(null, { status: 401 }) : new Response('ok')
  })
  await client.send(fetch as never, new Request('https://merchant.example'))
  expect(seen).toEqual([null, 'a, b'])
})

test('a retry returning headers never resends a paid attempt, and resends at most once', async () => {
  const retry = vi.fn(() => ({ 'X-Token': 't' }))
  const client = Identity.Client.from([{ scope: '*', prove: (request) => request, retry }])
  const fetch = vi.fn(async () => new Response(null, { status: 401 }))
  await client.send(fetch as never, new Request('https://merchant.example'), {
    challenge: testChallenge('paid'),
  })
  expect(fetch).toHaveBeenCalledTimes(1)
  expect(retry).not.toHaveBeenCalled()
  await client.send(fetch as never, new Request('https://merchant.example'))
  expect(fetch).toHaveBeenCalledTimes(3)
  expect(retry).toHaveBeenCalledTimes(1)
})

test('attempt transitions', () => {
  const { initial, transition } = Identity.Client
  const sent = transition(initial, { type: 'send', payment: 'unpaid' })
  const paid = transition(initial, { type: 'send', payment: 'paid' })
  expect([sent.phase, paid.phase]).toEqual(['sent', 'paid'])
  expect(Object.isFrozen(sent)).toBe(true)
  const resent = transition(sent, { type: 'response', resend: [['x-token', 't']] })
  expect(resent).toEqual({ phase: 'resent', headers: [['x-token', 't']] })
  for (const state of [sent, paid, resent])
    expect(transition(state, { type: 'response', resend: undefined })).toEqual({ phase: 'done' })
  const done = transition(sent, { type: 'response', resend: undefined })
  const illegal = [
    [paid, { type: 'response', resend: [] }, 'response with resend', 'paid'],
    [resent, { type: 'response', resend: [] }, 'response with resend', 'resent'],
    [initial, { type: 'response', resend: undefined }, 'response', 'unproved'],
    [done, { type: 'response', resend: undefined }, 'response', 'done'],
    [sent, { type: 'send', payment: 'unpaid' }, 'send', 'sent'],
  ] as const
  for (const [state, event, name, phase] of illegal)
    expect(() => transition(state, event)).toThrow(
      `Illegal identity attempt transition "${name}" from phase "${phase}".`,
    )
})

test('retry headers never replace a payment credential header', async () => {
  const client = Identity.Client.from([
    {
      scope: '*',
      prove: (request) => request,
      retry: () => ({ Authorization: 'Bearer leaked', 'Payment-Signature': 'x', 'X-Proof': '1' }),
    },
  ])
  const sent: Request[] = []
  const fetch = vi.fn(async (request: Request) => {
    sent.push(request)
    return sent.length === 1 ? new Response(null, { status: 401 }) : new Response('ok')
  })
  const first = await client.send(fetch as never, new Request('https://merchant.example'))
  expect(first.headers).toEqual([['x-proof', '1']])
  expect(sent[1]!.headers.has('Authorization')).toBe(false)
  expect(sent[1]!.headers.get('X-Proof')).toBe('1')
  // The paid attempt carries the retry headers without touching its Credential.
  const credential = Credential.serialize({ challenge: testChallenge('c'), payload: {} })
  await client.send(
    fetch as never,
    new Request('https://merchant.example', { headers: { Authorization: credential } }),
    { challenge: testChallenge('c'), headers: [['authorization', 'Bearer leaked']] },
  )
  expect(sent[2]!.headers.get('Authorization')).toBe(credential)
})

test('retry headers never replace the credential header a Challenge names', async () => {
  const challenge = Challenge.from({
    id: 'c',
    intent: 'charge',
    method: 'test',
    realm: 'merchant.example',
    request: { amount: '1' },
    header: 'X-Pay',
  })
  const client = Identity.Client.from([{ scope: '*', prove: (request) => request }])
  const sent: Request[] = []
  const fetch = vi.fn(async (request: Request) => {
    sent.push(request)
    return new Response('ok')
  })
  const credential = Credential.serialize({ challenge, payload: {} })
  await client.send(
    fetch as never,
    new Request('https://merchant.example', {
      headers: { 'X-Pay': credential, 'X-Other': credential },
    }),
    {
      challenge,
      headers: [
        ['x-pay', 'leaked'],
        ['x-other', 'leaked'],
        ['payment-authorization', 'leaked'],
        ['x-proof', '1'],
      ],
    },
  )
  expect(sent[0]!.headers.get('X-Pay')).toBe(credential)
  expect(sent[0]!.headers.get('X-Other')).toBe(credential)
  expect(sent[0]!.headers.has('Payment-Authorization')).toBe(false)
  expect(sent[0]!.headers.get('X-Proof')).toBe('1')
})

test('retry receives the request that got the response, as proved', async () => {
  const contexts: Identity.RetryContext[] = []
  const client = Identity.Client.from([
    {
      scope: '*',
      prove: header('X-Proof', 'proved'),
      retry(_, context) {
        contexts.push(context)
        return undefined
      },
    },
  ])
  await client.send(
    async () => new Response(null, { status: 401 }),
    new Request('https://a.example'),
  )
  expect(contexts).toHaveLength(1)
  expect(contexts[0]!.request.headers.get('X-Proof')).toBe('proved')
  expect(Object.isFrozen(contexts[0])).toBe(true)
})

test('exposes the headers provers declare, lowercased and frozen', () => {
  const client = Identity.Client.from([
    { scope: '*', prove: (request) => request, headers: ['X-Agent-Token'] },
    { scope: '*', prove: (request) => request, headers: ['x-agent-token', 'X-Other'] },
  ])
  expect(client.headers).toEqual(['x-agent-token', 'x-other'])
  expect(Object.isFrozen(client.headers)).toBe(true)
})
