import { Challenge, Credential, Method, Receipt, Store, z } from 'mppx'
import * as Persona from 'mppx/extensions/identity/persona'
import { Mppx } from 'mppx/server'
import { privateKeyToAccount } from 'viem/accounts'
import { expect, test } from 'vp/test'

const account = privateKeyToAccount(
  '0x0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
)
const payer = Persona.did({ address: account.address, chainId: 4217 })

const method = Method.from({
  name: 'test',
  intent: 'charge',
  schema: {
    credential: { payload: z.object({ token: z.string() }) },
    request: z.object({ amount: z.string(), currency: z.string(), recipient: z.string() }),
  },
})
let settlements = 0
const serverMethod = Method.toServer(method, {
  async verify() {
    settlements++
    return Receipt.from({
      method: 'test',
      reference: 'test-payment',
      status: 'success',
      timestamp: new Date().toISOString(),
    })
  },
})
const charge = { amount: '1', currency: 'USD', recipient: 'merchant' } as const

type Inquiry = {
  id: string
  attributes: Record<string, unknown>
  relationships?: { 'inquiry-template': { data: { id: string; type: 'inquiry-template' } } }
}

/** A fake Persona API: lists inquiries as the real endpoint filters them, and starts new ones. */
function fakePersona(inquiries: Inquiry[], options: { status?: number; pageSize?: number } = {}) {
  const calls: { body?: unknown; headers: Headers; method: string; url: URL }[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined
    calls.push({ body, headers: new Headers(init?.headers), method: init?.method ?? 'GET', url })
    if (options.status) return new Response('upstream error', { status: options.status })
    if (init?.method === 'POST' && url.pathname === '/api/v1/inquiries') {
      const id = `inq_${inquiries.length + 1}`
      inquiries.push({
        id,
        attributes: { status: 'created', 'reference-id': body.data.attributes['reference-id'] },
        relationships: template(body.data.attributes['inquiry-template-id']),
      })
      return Response.json({ data: { id, type: 'inquiry' } })
    }
    if (init?.method === 'POST' && url.pathname.endsWith('/generate-one-time-link'))
      return Response.json({ meta: { 'one-time-link': 'https://withpersona.com/verify?code=abc' } })
    const reference = url.searchParams.get('filter[reference-id]')
    const statuses = url.searchParams.get('filter[status]')!.split(',')
    const matches = inquiries.filter(
      (inquiry) =>
        inquiry.attributes['reference-id'] === reference &&
        statuses.includes(inquiry.attributes.status as string),
    )
    const size = options.pageSize ?? matches.length
    const start = Number(url.searchParams.get('page[after]') ?? 0)
    const next = start + size < matches.length ? start + size : undefined
    return Response.json({
      data: matches.slice(start, start + size),
      links: {
        next: next === undefined ? null : nextPage(url, next),
      },
    })
  }) as typeof globalThis.fetch
  return { calls, fetch, inquiries }
}

function template(id: string) {
  return { 'inquiry-template': { data: { id, type: 'inquiry-template' as const } } }
}

function nextPage(url: URL, after: number) {
  const next = new URL(url)
  next.searchParams.set('page[after]', String(after))
  return next.pathname + next.search
}

/** Reads the payer from the Credential's source: safe here, where the test method trusts it. */
const fromSource = ({ credential }: Persona.Server.create.PaymentParameters) =>
  credential?.source ? Persona.normalize(credential.source) : undefined

function approved(id: string, reference = payer, decisionedAt = new Date().toISOString()): Inquiry {
  return {
    id,
    attributes: { status: 'approved', 'reference-id': reference, 'decisioned-at': decisionedAt },
  }
}

async function pay(kyc: ReturnType<Persona.Server.Persona['paymentCheck']>, source?: string) {
  const mppx = Mppx.create({
    methods: [serverMethod],
    realm: 'localhost',
    secretKey: 'test-secret-key-test-secret-key-32',
  })
  const route = mppx.charge({ ...charge, identity: { payment: kyc } })
  const request = new Request('https://api.example/resource')
  const offered = await route(request)
  if (offered.status !== 402) throw new Error('expected a 402')
  const challenge = Challenge.fromResponse(offered.challenge)
  const credential = Credential.serialize({
    challenge,
    payload: { token: 'paid' },
    ...(source && { source }),
  })
  const result = await route(new Request(request, { headers: { Authorization: credential } }))
  return {
    offered: offered.challenge,
    response: result.status === 402 ? result.challenge : undefined,
    result,
    value: result.status === 200 ? result.identity?.get(kyc) : undefined,
  }
}

test('links a wallet, starts an inquiry, and accepts the payer once approved', async () => {
  const api = fakePersona([])
  const persona = Persona.Server.create({
    apiKey: 'persona_key',
    fetch: api.fetch,
    templateId: 'itmpl_1',
  })

  const nonce = 'n-123'
  const message = `Link ${payer} to KYC on api.example. Nonce: ${nonce}`
  const referenceId = await Persona.Server.verifyWallet({
    address: account.address,
    chainId: 4217,
    message,
    nonce,
    signature: await account.signMessage({ message }),
  })
  expect(referenceId).toBe(payer)

  const started = await persona.startInquiry({ referenceId })
  expect(started).toEqual({ inquiryId: 'inq_1', url: 'https://withpersona.com/verify?code=abc' })
  expect(api.calls[0]!.body).toEqual({
    data: { attributes: { 'inquiry-template-id': 'itmpl_1', 'reference-id': payer } },
  })
  expect(api.calls[0]!.headers.get('Authorization')).toBe('Bearer persona_key')

  const kyc = persona.paymentCheck({
    onboarding: 'https://api.example/kyc',
    referenceId: fromSource,
  })
  const pending = await pay(kyc, payer)
  expect(pending.response?.status).toBe(403)
  expect(pending.response?.headers.get('Link')).toBe('<https://api.example/kyc>; rel="kyc"')

  api.inquiries[0] = { ...api.inquiries[0]!, attributes: { ...approved('inq_1').attributes } }
  const before = settlements
  // The Credential's source checksums the address; the check normalizes it.
  const { offered, result, value } = await pay(kyc, `did:pkh:eip155:4217:${account.address}`)
  expect(offered.headers.get('Identity-Required')).toBe('kyc;issuer="https://api.withpersona.com"')
  expect(result.status).toBe(200)
  expect(value).toMatchObject({ inquiryId: 'inq_1', referenceId: payer, status: 'approved' })
  expect(settlements).toBe(before + 1)
  const lookup = api.calls.at(-1)!.url.searchParams
  expect(lookup.get('filter[inquiry-template-id]')).toBe('itmpl_1')
  expect(lookup.get('filter[status]')).toBe('approved')
})

test('rejects a wallet signature without the nonce, for another chain, or from another address', async () => {
  const other = '0x209693Bc6afc0C5328bA36FaF03C514EF312287C'
  const message =
    'Link ' + payer + ' and ' + Persona.did({ address: other, chainId: 4217 }) + '. Nonce: n-1'
  const signature = await account.signMessage({ message })
  const base = {
    address: account.address,
    chainId: 4217,
    message,
    nonce: 'n-1',
    signature,
  } as const
  await expect(Persona.Server.verifyWallet({ ...base, nonce: 'n-2' })).rejects.toThrow('nonce')
  // The signer committed to chain 4217 only.
  await expect(Persona.Server.verifyWallet({ ...base, chainId: 1 })).rejects.toThrow("wallet's DID")
  await expect(Persona.Server.verifyWallet({ ...base, address: other })).rejects.toThrow(
    'does not match',
  )
  const chains: number[] = []
  await Persona.Server.verifyWallet({
    ...base,
    async verify({ chainId }) {
      chains.push(chainId)
      return true
    },
  })
  expect(chains).toEqual([4217])
})

test('never follows a pagination link to another origin', async () => {
  const urls: string[] = []
  const fetch = (async (input: RequestInfo | URL) => {
    urls.push(new URL(String(input)).origin)
    return Response.json({ data: [], links: { next: 'https://evil.example/api/v1/inquiries' } })
  }) as typeof globalThis.fetch
  await pay(
    Persona.Server.create({ apiKey: 'k', fetch }).paymentCheck({ referenceId: fromSource }),
    payer,
  )
  expect(urls).toEqual(['https://api.withpersona.com'])
})

test('never follows a protocol-relative pagination path to another origin', async () => {
  const urls: string[] = []
  const fetch = (async (input: RequestInfo | URL) => {
    urls.push(new URL(String(input)).origin)
    const next = urls.length < 3 ? 'https://api.withpersona.com//evil.example/x' : null
    return Response.json({ data: [], links: { next } })
  }) as typeof globalThis.fetch
  await pay(
    Persona.Server.create({ apiKey: 'k', fetch }).paymentCheck({ referenceId: fromSource }),
    payer,
  )
  expect(urls.length).toBeGreaterThan(1)
  expect(new Set(urls)).toEqual(new Set(['https://api.withpersona.com']))
})

test('rejects without settling, as missing or forbidden, with the onboarding link', async () => {
  const api = fakePersona([
    { id: 'inq_1', attributes: { status: 'declined', 'reference-id': payer } },
  ])
  const persona = Persona.Server.create({ apiKey: 'k', fetch: api.fetch })
  const kyc = persona.paymentCheck({
    referenceId: fromSource,
    onboarding: ({ referenceId }) => `/kyc?for=${referenceId ?? ''}`,
  })
  const before = settlements

  const declined = await pay(kyc, payer)
  expect(declined.result.status === 402 && declined.result.rejection).toEqual({
    stage: 'payment',
    status: 'forbidden',
    reason: 'The payer has not passed Persona KYC.',
  })
  expect(declined.response?.headers.get('Link')).toBe(`</kyc?for=${payer}>; rel="kyc"`)

  const calls = api.calls.length
  const anonymous = await pay(kyc)
  expect(anonymous.response?.status).toBe(401)
  expect(anonymous.response?.headers.get('Link')).toBe('</kyc?for=>; rel="kyc"')
  expect(api.calls).toHaveLength(calls)
  expect(settlements).toBe(before)
})

test('maps a Persona API failure to unavailable without its body', async () => {
  const api = fakePersona([], { status: 500 })
  const { result, response } = await pay(
    Persona.Server.create({ apiKey: 'k', fetch: api.fetch }).paymentCheck({
      referenceId: fromSource,
    }),
    payer,
  )
  expect(result.status === 402 && result.rejection).toEqual({
    stage: 'payment',
    status: 'unavailable',
    reason: 'Persona KYC verification is unavailable.',
  })
  expect(response?.status).toBe(503)
})

test('caches approvals only', async () => {
  const api = fakePersona([approved('inq_1')])
  const persona = Persona.Server.create({ apiKey: 'k', fetch: api.fetch })
  const kyc = persona.paymentCheck({ cache: Store.memory(), referenceId: fromSource })
  expect((await pay(kyc, payer)).result.status).toBe(200)
  expect((await pay(kyc, payer)).result.status).toBe(200)
  expect(api.calls).toHaveLength(1)

  const other = Persona.did({
    address: '0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
    chainId: 4217,
  })
  await pay(kyc, other)
  await pay(kyc, other)
  expect(api.calls).toHaveLength(3)
})

test('does not share cached approvals across Persona organizations', async () => {
  const cache = Store.memory()
  const approvedApi = fakePersona([approved('inq_1')])
  const emptyApi = fakePersona([])
  const a = Persona.Server.create({ apiKey: 'org-a', fetch: approvedApi.fetch }).paymentCheck({
    cache,
    referenceId: fromSource,
  })
  const b = Persona.Server.create({ apiKey: 'org-b', fetch: emptyApi.fetch }).paymentCheck({
    cache,
    referenceId: fromSource,
  })
  expect((await pay(a, payer)).result.status).toBe(200)
  expect((await pay(b, payer)).response?.status).toBe(403)
  expect(emptyApi.calls).toHaveLength(1)
})

test("applies each check's own cacheTtl to a shared cache", async () => {
  const cache = Store.memory()
  const api = fakePersona([approved('inq_1')])
  const persona = Persona.Server.create({ apiKey: 'k', fetch: api.fetch })
  const lenient = persona.paymentCheck({ cache, cacheTtl: 3600, referenceId: fromSource })
  const strict = persona.paymentCheck({ cache, cacheTtl: 0, referenceId: fromSource })
  expect((await pay(lenient, payer)).result.status).toBe(200)
  api.inquiries.length = 0
  expect((await pay(lenient, payer)).result.status).toBe(200)
  expect((await pay(strict, payer)).response?.status).toBe(403)
})

test('applies maxAge across pages, and a custom referenceId', async () => {
  const old = new Date(Date.now() - 7_200_000).toISOString()
  const api = fakePersona(
    [
      approved('inq_a', 'customer-1', old),
      approved('inq_b', 'customer-1', old),
      approved('inq_c', 'customer-1'),
    ],
    { pageSize: 1 },
  )
  const persona = Persona.Server.create({ apiKey: 'k', fetch: api.fetch })
  const options = { referenceId: () => 'customer-1' }
  expect(
    (await pay(persona.paymentCheck({ ...options, maxAge: 3_600 }), payer)).value,
  ).toMatchObject({
    inquiryId: 'inq_c',
    referenceId: 'customer-1',
  })
  expect(api.calls).toHaveLength(3)
})

test('accepts only inquiries from the configured template', async () => {
  const other = { ...approved('inq_2'), relationships: template('itmpl_other') }
  const untagged = approved('inq_3')
  const fetch = (async () =>
    Response.json({ data: [other, untagged], links: { next: null } })) as typeof globalThis.fetch
  const kyc = Persona.Server.create({ apiKey: 'k', fetch, templateId: 'itmpl_1' }).paymentCheck({
    referenceId: fromSource,
  })
  expect((await pay(kyc, payer)).response?.status).toBe(403)

  const matching = { ...approved('inq_1'), relationships: template('itmpl_1') }
  const ok = (async () =>
    Response.json({ data: [other, matching], links: { next: null } })) as typeof globalThis.fetch
  const accepted = Persona.Server.create({
    apiKey: 'k',
    fetch: ok,
    templateId: 'itmpl_1',
  }).paymentCheck({ referenceId: fromSource })
  expect((await pay(accepted, payer)).value).toMatchObject({ inquiryId: 'inq_1' })
})

test('ignores inquiries the API returns outside its filters', async () => {
  const fetch = (async () =>
    Response.json({ data: [approved('inq_wrong', 'someone-else')] })) as typeof globalThis.fetch
  const { result } = await pay(
    Persona.Server.create({ apiKey: 'k', fetch }).paymentCheck({ referenceId: fromSource }),
    payer,
  )
  expect(result.status === 402 && result.rejection).toMatchObject({ status: 'forbidden' })
})

test('requires KYC before any 402 with a request-stage verifier', async () => {
  const api = fakePersona([approved('inq_1', 'customer-1')])
  const verifier = Persona.Server.create({ apiKey: 'k', fetch: api.fetch }).verifier({
    referenceId: (request) => request.headers.get('X-Customer') ?? undefined,
  })
  expect(await verifier.verify(new Request('https://api.example'))).toMatchObject({
    status: 'missing',
  })
  expect(
    await verifier.verify(
      new Request('https://api.example', { headers: { 'X-Customer': 'customer-1' } }),
    ),
  ).toMatchObject({ status: 'valid', value: { inquiryId: 'inq_1' } })
})

test('normalizes DIDs per chain', () => {
  expect(Persona.did({ address: '0xAbC', chainId: 4217 })).toBe('did:pkh:eip155:4217:0xabc')
  expect(Persona.did({ address: 'So1AnaBase58', chainId: 'mainnet', namespace: 'solana' })).toBe(
    'did:pkh:solana:mainnet:So1AnaBase58',
  )
})

test('validates its config', () => {
  expect(() => Persona.Server.create({ apiKey: '' })).toThrow('needs an apiKey')
  for (const timeout of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 31])
    expect(() => Persona.Server.create({ apiKey: 'k', timeout })).toThrow('timeout')
})
