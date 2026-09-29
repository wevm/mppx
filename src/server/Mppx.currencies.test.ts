import fc from 'fast-check'
import { expect, test, vi } from 'vp/test'

import * as Challenge from '../Challenge.js'
import * as Credential from '../Credential.js'
import * as Mcp from '../Mcp.js'
import * as Method from '../Method.js'
import * as z from '../zod.js'
import * as Mppx from './Mppx.js'
import * as Transport from './Transport.js'

const secretKey = 'test-secret-key-test-secret-key-32'
const definition = Method.from({
  name: 'test',
  intent: 'charge',
  schema: {
    credential: { payload: z.object({ token: z.string() }) },
    request: z.object({ amount: z.string(), currency: z.string() }),
  },
})

function fixture(currencies = ['A', 'B']) {
  return currencies.map((currency) =>
    Method.toServer<typeof definition, { currency: string }>(definition, {
      defaults: { currency },
      onPaymentSuccess: vi.fn(),
      verify: vi.fn(async () => ({
        method: 'test',
        status: 'success' as const,
        reference: currency,
        timestamp: new Date().toISOString(),
      })),
    }),
  )
}

test('shorthand and named groups preserve configured ordering', async () => {
  await fc.assert(
    fc.asyncProperty(
      fc.uniqueArray(fc.constantFrom('A', 'B', 'C'), { minLength: 1 }),
      async (currencies) => {
        const methods = fixture(currencies)
        const server = Mppx.create({ methods: [methods], secretKey })
        for (const route of [server.charge({ amount: '1' }), server.test.charge({ amount: '1' })]) {
          const result = await route(new Request('https://example.com'))
          if (result.status !== 402) throw new Error('Expected payment offers')
          expect(
            Challenge.fromResponseList(result.challenge).map(({ request }) => request.currency),
          ).toEqual(currencies)
        }
      },
    ),
  )
})

test('nested composition selects individual offers exactly once', async () => {
  const methods = fixture()
  const selectOffers = vi.fn<Mppx.SelectOffers<typeof methods>>((offers) =>
    offers.filter((offer) => offer.request.currency === 'B'),
  )
  const canOffer = vi.fn(() => true)
  for (const method of methods) method.canOffer = canOffer
  const server = Mppx.create({ methods: [methods], secretKey, selectOffers })
  for (const route of [
    server.charge({ amount: '1' }),
    server.test.charge({ amount: '1' }),
    server.compose(['test/charge', { amount: '1' }]),
    server.compose([server.test.charge, { amount: '1' }]),
    Mppx.compose(server.charge({ amount: '1' })),
    Mppx.compose(server.test.charge({ amount: '1' })),
    Mppx.compose(Mppx.compose(server.charge({ amount: '1' }))),
  ]) {
    const offered = await route(new Request('https://example.com'))
    if (offered.status !== 402) throw new Error('Expected payment offers')
    expect(
      Challenge.fromResponseList(offered.challenge).map(({ request }) => request.currency),
    ).toEqual(['B'])
    expect(selectOffers).toHaveBeenCalledTimes(1)
    expect(canOffer).toHaveBeenCalledTimes(2)
    vi.clearAllMocks()
  }
})

test('HTTP entry points preserve method instances and invoke only the selected callback', async () => {
  const methods = fixture()
  const server = Mppx.create({ methods: [methods], secretKey })
  for (const route of [
    server.charge({ amount: '1' }),
    server.test.charge({ amount: '1' }),
    server.compose(['test/charge', { amount: '1' }]),
    server.compose([server.test.charge, { amount: '1' }]),
    server.compose([methods[0]!, { amount: '1' }], [methods[1]!, { amount: '1' }]),
  ]) {
    const offered = await route(new Request('https://example.com'))
    if (offered.status !== 402) throw new Error('Expected payment offers')
    const challenges = Challenge.fromResponseList(offered.challenge)
    expect(challenges.map(({ request }) => request.currency)).toEqual(['A', 'B'])
    for (const [index, challenge] of challenges.entries()) {
      const authorization = Credential.serialize(
        Credential.from({ challenge, payload: { token: 'fixture' } }),
      )
      expect(
        (await route(new Request('https://example.com', { headers: { authorization } }))).status,
      ).toBe(200)
      expect(methods[index]!.verify).toHaveBeenCalledTimes(1)
      expect(methods[index]!.onPaymentSuccess).toHaveBeenCalledTimes(1)
      expect(methods[1 - index]!.verify).not.toHaveBeenCalled()
      expect(methods[1 - index]!.onPaymentSuccess).not.toHaveBeenCalled()
      vi.clearAllMocks()
    }
  }
})

test('standalone verification selects the matching configured currency', async () => {
  const methods = fixture()
  const server = Mppx.create({ methods: [methods], secretKey })
  const route = server.charge({ amount: '1' })
  const offered = await route(new Request('https://example.com'))
  if (offered.status !== 402) throw new Error('Expected payment offers')
  const challenge = Challenge.fromResponseList(offered.challenge)[1]!
  const credential = Credential.from({ challenge, payload: { token: 'fixture' } })
  const receipt = await server.verifyCredential(credential, { request: { amount: '1' } })
  expect(receipt.reference).toBe('B')
  expect(methods[0]!.verify).not.toHaveBeenCalled()
  expect(methods[0]!.onPaymentSuccess).not.toHaveBeenCalled()
  expect(methods[1]!.onPaymentSuccess).toHaveBeenCalledTimes(1)
})

test('grouped shorthand preserves aliases while named handlers keep their own offers', async () => {
  const methods = fixture()
  const aliased = { ...fixture()[0]!, alias: 'alternate' as const, defaults: { currency: 'C' } }
  const server = Mppx.create({ methods: [methods, aliased], secretKey })
  for (const [route, expected] of [
    [server.charge({ amount: '1' }), ['A', 'B', 'C']],
    [server.test.charge({ amount: '1' }), ['A', 'B']],
    [server.test.alternate({ amount: '1' }), ['C']],
    [server.compose([server.test.alternate, { amount: '1' }]), ['C']],
  ] as const) {
    const result = await route(new Request('https://example.com'))
    if (result.status !== 402) throw new Error('Expected payment offers')
    expect(
      Challenge.fromResponseList(result.challenge).map(({ request }) => request.currency),
    ).toEqual(expected)
  }
})

test('singular challenge generation selects the first configured currency', async () => {
  const server = Mppx.create({ methods: [fixture()], secretKey, realm: 'example.com' })
  const challenge = await server.challenge.test.charge({ amount: '1' })
  expect(challenge.request.currency).toBe('A')
})

test('MCP entry points offer both currencies and dispatch a selected credential once', async () => {
  const methods = fixture()
  const server = Mppx.create({
    methods: [methods],
    secretKey,
    realm: 'example.com',
    transport: Transport.mcpSdk(),
  })
  for (const route of [
    server.charge({ amount: '1' }),
    server.test.charge({ amount: '1' }),
    server.compose(['test/charge', { amount: '1' }]),
  ]) {
    const offered = await route({})
    if (offered.status !== 402) throw new Error('Expected payment offers')
    const data = offered.challenge.data as NonNullable<Mcp.ErrorObject['data']>
    expect(data.challenges.map(({ request }) => request.currency)).toEqual(['A', 'B'])
    const credential = Credential.from({
      challenge: data.challenges[1]!,
      payload: { token: 'fixture' },
    })
    const paid = await route({ _meta: { [Mcp.credentialMetaKey]: credential } })
    expect(paid.status).toBe(200)
    expect(methods[0]!.verify).not.toHaveBeenCalled()
    expect(methods[1]!.verify).toHaveBeenCalledTimes(1)
    expect(methods[0]!.onPaymentSuccess).not.toHaveBeenCalled()
    expect(methods[1]!.onPaymentSuccess).toHaveBeenCalledTimes(1)
    vi.clearAllMocks()
  }
})
