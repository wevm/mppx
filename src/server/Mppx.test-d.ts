import { Method, z } from 'mppx'
import { Mppx } from 'mppx/server'
import { assertType, describe, expectTypeOf, test } from 'vp/test'

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

const alphaMethod = Method.toServer(mockChargeA, {
  async verify() {
    return {
      method: 'alpha',
      reference: 'tx',
      status: 'success' as const,
      timestamp: new Date().toISOString(),
    }
  },
})

const betaMethod = Method.toServer(mockChargeB, {
  async verify() {
    return {
      method: 'beta',
      reference: 'tx',
      status: 'success' as const,
      timestamp: new Date().toISOString(),
    }
  },
})

const secretKey = 'test-secret'
const realm = 'api.example.com'

describe('Mppx type tests', () => {
  test('compose exists on the instance and returns a handler', () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    expectTypeOf(mppx.compose).toBeFunction()
  })

  test('compose accepts method reference tuples', () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    const opts = {
      amount: '100',
      currency: '0x01',
      decimals: 6,
      recipient: '0x02',
    }

    // Should compile — method reference entries
    const handler = mppx.compose([alphaMethod, opts], [betaMethod, opts])
    expectTypeOf(handler).toBeFunction()
  })

  test('compose accepts string key tuples', () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    const opts = {
      amount: '100',
      currency: '0x01',
      decimals: 6,
      recipient: '0x02',
    }

    // Should compile — string key entries
    const handler = mppx.compose(['alpha/charge', opts], ['beta/charge', opts])
    expectTypeOf(handler).toBeFunction()
  })

  test('nested handlers are accessible', () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    expectTypeOf(mppx.alpha).toBeObject()
    expectTypeOf(mppx.alpha.charge).toBeFunction()
    expectTypeOf(mppx.beta).toBeObject()
    expectTypeOf(mppx.beta.charge).toBeFunction()
  })

  test('slash key handlers are accessible', () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    expectTypeOf(mppx['alpha/charge']).toBeFunction()
    expectTypeOf(mppx['beta/charge']).toBeFunction()
  })

  test('compose return type is a request handler returning the response union', () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })

    const opts = {
      amount: '100',
      currency: '0x01',
      decimals: 6,
      recipient: '0x02',
    }

    const _handler = mppx.compose([alphaMethod, opts])
    type HandlerReturn = ReturnType<typeof _handler>

    assertType<Promise<{ status: 402; challenge: Response } | { status: 200; withReceipt: any }>>(
      {} as Awaited<HandlerReturn> as any,
    )
  })

  test('static Mppx.compose accepts configured handlers', () => {
    expectTypeOf(Mppx.compose).toBeFunction()
  })

  test('challenge namespace has nested accessors matching methods', () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    expectTypeOf(mppx.challenge).toBeObject()
    expectTypeOf(mppx.challenge.alpha).toBeObject()
    expectTypeOf(mppx.challenge.alpha.charge).toBeFunction()
    expectTypeOf(mppx.challenge.beta).toBeObject()
    expectTypeOf(mppx.challenge.beta.charge).toBeFunction()
  })

  test('challenge functions return Promise<Challenge>', () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })

    const challenge = mppx.challenge.alpha.charge({
      amount: '100',
      currency: '0x01',
      decimals: 6,
      recipient: '0x02',
    })

    expectTypeOf(challenge).toMatchTypeOf<Promise<unknown>>()

    type AwaitedChallenge = Awaited<typeof challenge>
    expectTypeOf<AwaitedChallenge>().toHaveProperty('id')
    expectTypeOf<AwaitedChallenge>().toHaveProperty('realm')
    expectTypeOf<AwaitedChallenge>().toHaveProperty('method')
    expectTypeOf<AwaitedChallenge>().toHaveProperty('intent')
    expectTypeOf<AwaitedChallenge>().toHaveProperty('request')
  })

  test('verifyCredential exists and returns Promise<Receipt>', () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })

    expectTypeOf(mppx.verifyCredential).toBeFunction()
  })

  test('handler options and verifyCredential accept scope', () => {
    const mppx = Mppx.create({ methods: [alphaMethod], realm, secretKey })

    expectTypeOf(
      mppx.charge({
        amount: '100',
        currency: '0x01',
        decimals: 6,
        recipient: '0x02',
        scope: 'GET /premium',
      }),
    ).toBeFunction()

    expectTypeOf(mppx.verifyCredential('credential', { scope: 'GET /premium' })).toMatchTypeOf<
      Promise<unknown>
    >()
  })
})
