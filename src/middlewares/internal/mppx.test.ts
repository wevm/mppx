import { Challenge, Credential, Method, z } from 'mppx'
import { Mppx } from 'mppx/server'
import { describe, expect, test } from 'vitest'
import { wrap } from './mppx.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'

const mockChargeA = Method.from({
  name: 'alpha',
  intent: 'charge',
  schema: {
    credential: {
      payload: z.object({ token: z.string() }),
    },
    request: z.object({
      amount: z.string(),
      currency: z.string(),
      decimals: z.number(),
      recipient: z.string(),
    }),
  },
})

const mockChargeB = Method.from({
  name: 'beta',
  intent: 'charge',
  schema: {
    credential: {
      payload: z.object({ token: z.string() }),
    },
    request: z.object({
      amount: z.string(),
      currency: z.string(),
      decimals: z.number(),
      recipient: z.string(),
    }),
  },
})

function mockReceipt(name: string) {
  return {
    method: name,
    reference: `tx-${name}`,
    status: 'success' as const,
    timestamp: new Date().toISOString(),
  }
}

const alphaMethod = Method.toServer(mockChargeA, {
  async verify() {
    return mockReceipt('alpha')
  },
})

const betaMethod = Method.toServer(mockChargeB, {
  async verify() {
    return mockReceipt('beta')
  },
})

const challengeOpts = {
  amount: '1000',
  currency: '0x0000000000000000000000000000000000000001',
  decimals: 6,
  expires: new Date(Date.now() + 60_000).toISOString(),
  recipient: '0x0000000000000000000000000000000000000002',
}

describe('wrap: nested handlers', () => {
  test('wrapped.alpha.charge produces a wrapped handler', () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey }) as any

    const wrapped = wrap(mppx, (methodFn, options) => {
      return { type: 'wrapped' as const, handler: methodFn(options) }
    })

    const result = wrapped.alpha.charge(challengeOpts)
    expect(result.type).toBe('wrapped')
    expect(typeof result.handler).toBe('function')
  })

  test('wrapped.beta.charge produces a wrapped handler', () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey }) as any

    const wrapped = wrap(mppx, (methodFn, options) => {
      return { type: 'wrapped' as const, handler: methodFn(options) }
    })

    const result = wrapped.beta.charge(challengeOpts)
    expect(result.type).toBe('wrapped')
  })

  test('nested wrapped handler works end-to-end (402 then 200)', async () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey }) as any

    const wrapped = wrap(mppx, (methodFn, options) => methodFn(options))

    const handle = wrapped.alpha.charge(challengeOpts)

    const firstResult = await handle(new Request('https://example.com/resource'))
    expect(firstResult.status).toBe(402)
    if (firstResult.status !== 402) throw new Error()

    const challenge = Challenge.fromResponse(firstResult.challenge)
    const credential = Credential.from({ challenge, payload: { token: 'valid' } })

    const result = await handle(
      new Request('https://example.com/resource', {
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(result.status).toBe(200)
  })

  test('slash key and nested key produce equivalent wrapped handlers', () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey }) as any

    const wrapped = wrap(mppx, (methodFn, options) => {
      return { methodFn, options }
    })

    const nestedResult = wrapped.alpha.charge(challengeOpts) as {
      methodFn: unknown
      options: unknown
    }
    const slashResult = wrapped['alpha/charge'](challengeOpts) as {
      methodFn: unknown
      options: unknown
    }

    expect(nestedResult.methodFn).toBe(slashResult.methodFn)
    expect(nestedResult.options).toEqual(slashResult.options)
  })

  test('compose is omitted from wrapped object', () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey }) as any

    const wrapped = wrap(mppx, (_methodFn, _options) => 'wrapped')

    expect(wrapped.compose).toBeUndefined()
  })

  test('realm and transport are passed through', () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey }) as any

    const wrapped = wrap(mppx, (_methodFn, _options) => 'wrapped')

    expect(wrapped.realm).toBe(realm)
    expect(wrapped.transport).toBe(mppx.transport)
  })
})
