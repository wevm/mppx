import { Challenge, Credential, Method, Receipt, z } from 'mppx'
import * as Persona from 'mppx/extensions/identity/persona'
import { Mppx } from 'mppx/server'
import { expect, test } from 'vp/test'

const payer = 'did:pkh:eip155:4217:0x209693bc6afc0c5328ba36faf03c514ef312287c'

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

type Inquiry = { id: string; attributes: Record<string, unknown> }

/** A fake Persona API that filters its inquiries as the real list endpoint does. */
function persona(inquiries: Inquiry[], options: { status?: number } = {}) {
  const calls: { headers: Headers; url: URL }[] = []
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input))
    calls.push({ headers: new Headers(init?.headers), url })
    if (options.status) return new Response('upstream error', { status: options.status })
    const reference = url.searchParams.get('filter[reference-id]')
    const statuses = url.searchParams.get('filter[status]')!.split(',')
    return Response.json({
      data: inquiries.filter(
        (inquiry) =>
          inquiry.attributes['reference-id'] === reference &&
          statuses.includes(inquiry.attributes.status as string),
      ),
    })
  }) as typeof globalThis.fetch
  return { calls, fetch }
}

function approved(id: string, reference = payer, decisionedAt = new Date().toISOString()): Inquiry {
  return {
    id,
    attributes: { status: 'approved', 'reference-id': reference, 'decisioned-at': decisionedAt },
  }
}

async function pay(kyc: ReturnType<typeof Persona.Server.check>, source?: string) {
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
    result,
    value: result.status === 200 ? result.identity?.get(kyc) : undefined,
  }
}

test('advertises kyc from Persona and accepts a payer with an approved inquiry', async () => {
  const api = persona([approved('inq_old'), approved('inq_other', 'did:pkh:eip155:4217:0xother')])
  const kyc = Persona.Server.check({ apiKey: 'persona_test_key', fetch: api.fetch })
  const before = settlements
  const { offered, result, value } = await pay(
    kyc,
    'did:pkh:eip155:4217:0x209693Bc6afc0C5328bA36FaF03C514EF312287C',
  )

  expect(offered.headers.get('Identity-Required')).toBe('kyc;issuer="https://withpersona.com"')
  expect(result.status).toBe(200)
  expect(value).toMatchObject({ inquiryId: 'inq_old', referenceId: payer, status: 'approved' })
  expect(settlements).toBe(before + 1)
  const [call] = api.calls
  expect(call!.url.origin + call!.url.pathname).toBe('https://api.withpersona.com/api/v1/inquiries')
  expect(call!.url.searchParams.get('filter[reference-id]')).toBe(payer)
  expect(call!.url.searchParams.get('filter[status]')).toBe('approved')
  expect(call!.headers.get('Authorization')).toBe('Bearer persona_test_key')
  expect(call!.headers.get('Persona-Version')).toBe(Persona.Constants.apiVersion)
})

test('rejects a payer without an approved inquiry with 403, before settlement', async () => {
  const api = persona([{ id: 'inq_1', attributes: { status: 'declined', 'reference-id': payer } }])
  const before = settlements
  const { result } = await pay(Persona.Server.check({ apiKey: 'k', fetch: api.fetch }), payer)
  expect(result.status).toBe(402)
  expect(result.status === 402 && result.rejection).toEqual({
    stage: 'payment',
    status: 'forbidden',
    reason: 'The payer has not passed Persona KYC.',
  })
  expect(result.status === 402 && result.challenge.status).toBe(403)
  expect(settlements).toBe(before)
})

test('rejects a Credential without a source as missing, without calling Persona', async () => {
  const api = persona([approved('inq_1')])
  const { result } = await pay(Persona.Server.check({ apiKey: 'k', fetch: api.fetch }))
  expect(result.status === 402 && result.rejection).toMatchObject({ status: 'missing' })
  expect(api.calls).toHaveLength(0)
})

test('maps a Persona API failure to unavailable without its body', async () => {
  const api = persona([], { status: 500 })
  const { result } = await pay(Persona.Server.check({ apiKey: 'k', fetch: api.fetch }), payer)
  expect(result.status === 402 && result.rejection).toEqual({
    stage: 'payment',
    status: 'unavailable',
    reason: 'Persona KYC verification is unavailable.',
  })
  expect(result.status === 402 && result.challenge.status).toBe(503)
})

test('applies maxAge, templateId, statuses and a custom referenceId', async () => {
  const stale = approved('inq_stale', 'customer-1', new Date(Date.now() - 7_200_000).toISOString())
  const api = persona([stale])
  const options = { apiKey: 'k', fetch: api.fetch, referenceId: () => 'customer-1' }
  expect(
    (await pay(Persona.Server.check({ ...options, maxAge: 3_600 }), payer)).result.status,
  ).toBe(402)
  expect(
    (await pay(Persona.Server.check({ ...options, maxAge: 86_400 }), payer)).value,
  ).toMatchObject({
    inquiryId: 'inq_stale',
    referenceId: 'customer-1',
  })

  await pay(
    Persona.Server.check({
      ...options,
      statuses: ['approved', 'completed'],
      templateId: 'itmpl_1',
    }),
    payer,
  )
  const last = api.calls.at(-1)!.url.searchParams
  expect(last.get('filter[status]')).toBe('approved,completed')
  expect(last.get('filter[inquiry-template-id]')).toBe('itmpl_1')
})

test('ignores inquiries the API returns outside its filters', async () => {
  const fetch = (async () =>
    Response.json({ data: [approved('inq_wrong', 'someone-else')] })) as typeof globalThis.fetch
  const { result } = await pay(Persona.Server.check({ apiKey: 'k', fetch }), payer)
  expect(result.status === 402 && result.rejection).toMatchObject({ status: 'forbidden' })
})

test('validates its config', () => {
  expect(() => Persona.Server.check({ apiKey: '' })).toThrow('needs an apiKey')
  expect(() => Persona.Server.check({ apiKey: 'k', statuses: [] })).toThrow('at least one status')
  expect(() => Persona.Server.check({ apiKey: 'k', maxAge: 0 })).toThrow('positive integer')
})
