import { BodyDigest, Challenge, Constants, Credential, Errors, Method, z } from 'mppx'
import { Mppx } from 'mppx/server'
import { expect, test, vi } from 'vp/test'

const secretKey = 'test-secret-key-test-secret-key-32'
const realm = 'example.test'
const options = { amount: '1', currency: 'USD', expires: '2099-01-01T00:00:00Z' }
const url = 'https://example.test/paid'

function setup(verifyImpl?: () => Promise<never>, parameters: { requiresAuth?: boolean } = {}) {
  const verify = vi.fn(
    verifyImpl ??
      (async () => ({
        method: 'mock',
        status: 'success' as const,
        reference: 'paid',
        timestamp: new Date().toISOString(),
      })),
  )
  const method = Method.toServer(
    Method.from({
      name: 'mock',
      intent: 'charge',
      schema: {
        credential: { payload: z.object({ token: z.string() }) },
        request: z.object({ amount: z.string(), currency: z.string() }),
      },
    }),
    { verify: verify as never },
  )
  const mppx = Mppx.create({ methods: [method], realm, secretKey, ...parameters })
  return { handler: mppx.charge(options), mppx, verify }
}

function authorization(challenge: Challenge.Challenge) {
  return Credential.serialize({ challenge, payload: { token: 'valid' } })
}

async function problem(response: Response) {
  return (await response.json()) as { status: number; type: string }
}

test('more than one Payment credential gets 400 bad-request without a challenge', async () => {
  const { handler, mppx, verify } = setup()
  const challenge = await mppx.challenge.mock.charge(options)
  for (const headers of [
    { Authorization: `${authorization(challenge)}, ${authorization(challenge)}` },
    {
      Authorization: authorization(challenge),
      [Constants.Headers.paymentAuthorization]: authorization(challenge),
    },
  ]) {
    const result = await handler(new Request(url, { headers }))
    if (result.status !== 402) throw new Error('expected a rejection')
    expect(result.challenge.status).toBe(400)
    expect(result.challenge.headers.has('WWW-Authenticate')).toBe(false)
    expect((await problem(result.challenge)).type).toBe(
      'https://paymentauth.org/problems/bad-request',
    )
  }
  expect(verify).not.toHaveBeenCalled()
})

test('a credential in the field the challenge did not select is ignored', async () => {
  const { handler, mppx, verify } = setup(undefined, { requiresAuth: true })
  const challenge = await mppx.challenge.mock.charge(options)
  const result = await handler(
    new Request(url, { headers: { Authorization: authorization(challenge) } }),
  )
  if (result.status !== 402) throw new Error('expected a challenge')
  expect(result.challenge.status).toBe(402)
  expect(result.challenge.headers.has('WWW-Authenticate')).toBe(true)
  expect((await problem(result.challenge)).type).toBe(
    'https://paymentauth.org/problems/payment-required',
  )
  expect(verify).not.toHaveBeenCalled()
})

test('a bare Payment scheme counts as absent; a non-JSON token is malformed', async () => {
  const { handler } = setup()
  const absent = await handler(new Request(url, { headers: { Authorization: 'Payment' } }))
  if (absent.status !== 402) throw new Error('expected a challenge')
  expect((await problem(absent.challenge)).type).toBe(
    'https://paymentauth.org/problems/payment-required',
  )
  const malformed = await handler(new Request(url, { headers: { Authorization: 'Payment !!!' } }))
  if (malformed.status !== 402) throw new Error('expected a challenge')
  expect(malformed.challenge.headers.has('WWW-Authenticate')).toBe(true)
  expect((await problem(malformed.challenge)).type).toBe(
    'https://paymentauth.org/problems/malformed-credential',
  )
})

test('a body digest mismatch gets 402 invalid-challenge with a fresh challenge', async () => {
  const { handler, verify } = setup()
  const body = JSON.stringify({ prompt: 'hello' })
  const challenge = Challenge.from({
    ...options,
    digest: BodyDigest.compute(body),
    intent: 'charge',
    method: 'mock',
    realm,
    request: { amount: '1', currency: 'USD' },
    secretKey,
  })
  const send = (payload: string) =>
    handler(
      new Request(url, {
        body: payload,
        headers: { Authorization: authorization(challenge) },
        method: 'POST',
      }),
    )

  const mismatch = await send(JSON.stringify({ prompt: 'other' }))
  if (mismatch.status !== 402) throw new Error('expected a challenge')
  expect(mismatch.challenge.headers.has('WWW-Authenticate')).toBe(true)
  expect((await problem(mismatch.challenge)).type).toBe(
    'https://paymentauth.org/problems/invalid-challenge',
  )
  expect(verify).not.toHaveBeenCalled()

  expect((await send(body)).status).toBe(200)
  expect(verify).toHaveBeenCalledTimes(1)
})

test('a replayed credential gets 402 invalid-challenge with a fresh challenge', async () => {
  const { handler, mppx } = setup(async () => {
    throw new Errors.CredentialReplayedError()
  })
  const challenge = await mppx.challenge.mock.charge(options)
  const result = await handler(
    new Request(url, { headers: { Authorization: authorization(challenge) } }),
  )
  if (result.status !== 402) throw new Error('expected a challenge')
  expect(result.challenge.status).toBe(402)
  const fresh = Challenge.fromResponse(result.challenge)
  expect(fresh.id).not.toBe(challenge.id)
  expect(await problem(result.challenge)).toMatchObject({
    status: 402,
    type: 'https://paymentauth.org/problems/invalid-challenge',
  })
})
