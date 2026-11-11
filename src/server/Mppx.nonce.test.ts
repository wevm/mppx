import { Challenge, Credential, Method, PaymentRequest, z } from 'mppx'
import { Mppx } from 'mppx/server'
import { Base64 } from 'ox'
import { expect, test, vi } from 'vp/test'

const secretKey = 'test-secret-key-test-secret-key-32'
const realm = 'example.test'
const options = { amount: '1', currency: 'USD', expires: '2099-01-01T00:00:00Z' }

function setup() {
  const verify = vi.fn(async () => ({
    method: 'mock',
    status: 'success' as const,
    reference: 'paid',
    timestamp: new Date().toISOString(),
  }))
  const method = Method.toServer(
    Method.from({
      name: 'mock',
      intent: 'charge',
      schema: {
        credential: { payload: z.object({ token: z.string() }) },
        request: z.object({ amount: z.string(), currency: z.string() }),
      },
    }),
    { verify },
  )
  return { method, verify, mppx: Mppx.create({ methods: [method], realm, secretKey }) }
}

function request(challenge?: Challenge.Challenge) {
  return new Request('https://example.test/paid', {
    headers: challenge
      ? { Authorization: Credential.serialize({ challenge, payload: { token: 'valid' } }) }
      : {},
  })
}

test.each([undefined, options.expires])('fresh IDs even with expiration %s', async (expires) => {
  const { mppx } = setup()
  const challenges = await Promise.all(
    Array.from({ length: 10 }, () => mppx.challenge.mock.charge({ ...options, expires })),
  )
  expect(new Set(challenges.map((challenge) => challenge.id)).size).toBe(10)
  for (const challenge of challenges) {
    expect(challenge.meta?._mpp_nonce).toBeTypeOf('string')
    expect(Challenge.verify(challenge, { secretKey })).toBe(true)
  }
})

test('nonce is 16 random bytes, base64url without padding', async () => {
  const { mppx } = setup()
  const challenge = await mppx.challenge.mock.charge(options)
  expect(challenge.meta?._mpp_nonce).toMatch(/^[A-Za-z0-9_-]{22}$/)
  expect(Base64.toBytes(challenge.meta!._mpp_nonce!)).toHaveLength(16)
})

test('challengeNonce: false issues challenges without a nonce', async () => {
  const { method, verify } = setup()
  const mppx = Mppx.create({ challengeNonce: false, methods: [method], realm, secretKey })
  const first = await mppx.challenge.mock.charge(options)
  const second = await mppx.challenge.mock.charge(options)
  expect(first.meta).toBeUndefined()
  expect(first.opaque).toBeUndefined()
  expect(first.id).toBe(second.id)
  expect((await mppx.charge(options)(request(first))).status).toBe(200)
  expect(verify).toHaveBeenCalledTimes(1)
})

test('legacy _mppx_nonce in echoed metadata is ignored for route matching', async () => {
  const { mppx, verify } = setup()
  const challenge = Challenge.from({
    ...options,
    method: 'mock',
    intent: 'charge',
    meta: { order: 'one', _mppx_nonce: 'legacy' },
    realm,
    request: { amount: '1', currency: 'USD' },
    secretKey,
  })
  expect(
    (await mppx.charge({ ...options, meta: { order: 'one' } })(request(challenge))).status,
  ).toBe(200)
  expect(verify).toHaveBeenCalledTimes(1)
})

test('HTTP issuance preserves metadata and accepts echoed credentials', async () => {
  const { mppx, verify } = setup()
  const handler = mppx.charge({ ...options, meta: { order: 'one' }, scope: 'paid' })
  const first = await handler(request())
  const second = await handler(request())
  if (first.status !== 402 || second.status !== 402) throw new Error('expected challenges')
  const challenge = Challenge.fromResponse(first.challenge)
  expect(challenge.id).not.toBe(Challenge.fromResponse(second.challenge).id)
  expect(PaymentRequest.deserialize(challenge.opaque!)).toMatchObject({
    order: 'one',
    _mppx_scope: 'paid',
  })
  expect((await handler(request(challenge))).status).toBe(200)
  expect(verify).toHaveBeenCalledTimes(1)
})

test('issuance nonce does not weaken composed route metadata binding', async () => {
  const { mppx, method, verify } = setup()
  const challenge = await mppx.challenge.mock.charge({ ...options, meta: { order: 'one' } })
  const matching = mppx.compose([method, { ...options, meta: { order: 'one' } }])
  const other = mppx.compose([method, { ...options, meta: { order: 'two' } }])
  expect((await matching(request(challenge))).status).toBe(200)
  expect((await other(request(challenge))).status).toBe(402)
  expect(verify).toHaveBeenCalledTimes(1)
})

test('nonce changes invalidate the challenge HMAC', async () => {
  const { mppx, verify } = setup()
  const challenge = await mppx.challenge.mock.charge(options)
  const modified = Challenge.from({
    ...challenge,
    opaque: undefined,
    meta: { ...challenge.meta, _mpp_nonce: 'changed' },
  })
  expect(Challenge.verify(modified, { secretKey })).toBe(false)
  expect((await mppx.charge(options)(request(modified))).status).toBe(402)
  expect(verify).not.toHaveBeenCalled()
})

test('previously issued signed challenges without a nonce remain valid', async () => {
  const { mppx } = setup()
  const challenge = Challenge.from({
    ...options,
    method: 'mock',
    intent: 'charge',
    realm,
    request: { amount: '1', currency: 'USD' },
    secretKey,
  })
  expect((await mppx.charge(options)(request(challenge))).status).toBe(200)
})

test('issues challenges without global Web Crypto', async () => {
  vi.stubGlobal('crypto', undefined)
  try {
    const { mppx } = setup()
    const first = await mppx.challenge.mock.charge(options)
    const second = await mppx.challenge.mock.charge(options)
    expect(first.id).not.toBe(second.id)
    expect(Challenge.verify(first, { secretKey })).toBe(true)
    expect(Challenge.verify(second, { secretKey })).toBe(true)
  } finally {
    vi.unstubAllGlobals()
  }
})
