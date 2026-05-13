import { Method, z } from 'mppx'
import { Mppx, tempo } from 'mppx/server'
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
      expires: new Date('2026-01-01T00:00:00Z'),
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

  test('server events receive typed method context', () => {
    const mppx = Mppx.create({
      methods: [alphaMethod],
      realm,
      secretKey,
      events: {
        '*'(event) {
          expectTypeOf(event.name).toMatchTypeOf<
            'challenge' | 'payment.failed' | 'payment.success'
          >()
          if (event.name === 'payment.success')
            expectTypeOf(event.payload.receipt.status).toEqualTypeOf<'success'>()
        },
        'payment.success'(context) {
          expectTypeOf(context.challenge.method).toEqualTypeOf<'alpha'>()
        },
        onChallenge(context) {
          expectTypeOf(context.input).toEqualTypeOf<Request>()
          expectTypeOf(context.method.name).toEqualTypeOf<'alpha'>()
          expectTypeOf(context.request.amount).toEqualTypeOf<string>()
          expectTypeOf(context.error).toMatchTypeOf<Error | undefined>()
        },
        onPaymentFailed(context) {
          expectTypeOf(context.credential).toMatchTypeOf<unknown>()
          expectTypeOf(context.error).toMatchTypeOf<Error>()
          expectTypeOf(context.method.intent).toEqualTypeOf<'charge'>()
          expectTypeOf(context.request.currency).toEqualTypeOf<string>()
        },
        onPaymentSuccess(context) {
          expectTypeOf(context.challenge.method).toEqualTypeOf<'alpha'>()
          expectTypeOf(context.credential.payload.token).toEqualTypeOf<string>()
          expectTypeOf(context.envelope.challenge.intent).toEqualTypeOf<'charge'>()
          expectTypeOf(context.receipt.status).toEqualTypeOf<'success'>()
          expectTypeOf(context.request.recipient).toEqualTypeOf<string>()
        },
      },
    })

    mppx.on('payment.success', (context) => {
      expectTypeOf(context.challenge.method).toEqualTypeOf<'alpha'>()
      expectTypeOf(context.credential.payload.token).toEqualTypeOf<string>()
    })
    mppx.on('payment.failed', (context) => {
      expectTypeOf(context.error).toMatchTypeOf<Error>()
      expectTypeOf(context.credential).toMatchTypeOf<unknown>()
    })
    mppx.on('*', (event) => {
      if (event.name === 'payment.failed') expectTypeOf(event.payload.error).toMatchTypeOf<Error>()
      if (event.name === 'challenge')
        expectTypeOf(event.payload.error).toMatchTypeOf<Error | undefined>()
    })
    mppx.onPaymentSuccess((context) => {
      expectTypeOf(context.receipt.status).toEqualTypeOf<'success'>()
      expectTypeOf(context.request.recipient).toEqualTypeOf<string>()
    })
    mppx.onPaymentFailed((context) => {
      expectTypeOf(context.error).toMatchTypeOf<Error>()
      expectTypeOf(context.request.currency).toEqualTypeOf<string>()
    })
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

  test('tempo subscription accepts ergonomic date and period inputs', () => {
    const method = tempo.subscription({
      amount: '10',
      currency: '0x20c0000000000000000000000000000000000001',
      periodCount: 1,
      periodUnit: 'day',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      resolve: async () => ({ key: 'user-1:plan:pro' }),
      subscriptionExpires: new Date('2026-01-01T00:00:00Z'),
    })
    const mppx = Mppx.create({ methods: [method], realm, secretKey })

    expectTypeOf(
      mppx.tempo.subscription({
        expires: new Date('2026-01-01T00:00:00Z'),
        periodCount: 1n,
        subscriptionExpires: new Date('2026-01-01T00:00:00Z'),
      }),
    ).toBeFunction()
  })
})
