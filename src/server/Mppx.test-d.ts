import { Method, z } from 'mppx'
import { Mppx, tempo, Transport } from 'mppx/server'
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

const mockSession = Method.from({
  name: 'tempo',
  intent: 'session',
  schema: {
    credential: {
      payload: z.object({ token: z.string() }),
    },
    request: z.object({
      amount: z.string(),
      currency: z.string(),
      methodDetails: z.object({ sessionProtocol: z.string() }),
      unitType: z.string(),
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

const tip1034SessionMethod = Method.toServer(mockSession, {
  async verify() {
    return {
      method: 'tempo',
      reference: 'tx',
      status: 'success' as const,
      timestamp: new Date().toISOString(),
    }
  },
})

const alternateSessionMethod = Method.toServer(mockSession, {
  alias: 'alternateSession',
  async verify() {
    return {
      method: 'tempo',
      reference: 'tx',
      status: 'success' as const,
      timestamp: new Date().toISOString(),
    }
  },
})

const secretKey = 'test-secret-key-test-secret-key-32'
const realm = 'api.example.com'

describe('Mppx type tests', () => {
  test('method handlers expose method extensions', () => {
    const sessionMethod = tempo.session({
      amount: '1',
      currency: '0x0000000000000000000000000000000000000001',
      decimals: 6,
      getClient: () => null as never,
      recipient: '0x0000000000000000000000000000000000000002',
      unitType: 'token',
    })
    const mppx = Mppx.create({ methods: [sessionMethod], realm, secretKey })

    expectTypeOf(mppx.session.settleScheduled).toBeFunction()
    expectTypeOf(mppx.session.serveWebSocket).toBeFunction()
    type Options = Parameters<typeof mppx.session.serveWebSocket>[0]
    expectTypeOf<Options>().toHaveProperty('route')
    expectTypeOf<Options>().not.toHaveProperty('store')
    expectTypeOf<Options>().not.toHaveProperty('onChargeCommitted')
    expectTypeOf<Options>().not.toHaveProperty('settleScheduled')
    type LowLevelOptions = Parameters<typeof tempo.Ws.serve>[0]
    expectTypeOf<LowLevelOptions>().toHaveProperty('onChargeCommitted')
    expectTypeOf<LowLevelOptions>().toHaveProperty('settleScheduled')
  })

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

  test('selectOffers exposes typed methods, normalized requests, and the HTTP request', () => {
    Mppx.create({
      methods: [alphaMethod, betaMethod],
      realm,
      secretKey,
      selectOffers(offers, { request }) {
        expectTypeOf(request).toEqualTypeOf<Request>()
        expectTypeOf(offers[0]!.key).toEqualTypeOf<'alpha/charge' | 'beta/charge'>()
        expectTypeOf(offers[0]!.method.name).toEqualTypeOf<'alpha' | 'beta'>()
        expectTypeOf(offers[0]!.method.intent).toEqualTypeOf<'charge'>()
        expectTypeOf(offers[0]!.request.amount).toEqualTypeOf<string>()
        return offers.filter((offer) => offer.method.name !== 'beta')
      },
    })
  })

  test('method canOffer receives its normalized payment request and HTTP input', () => {
    Method.toServer(mockChargeA, {
      canOffer({ input, request }) {
        expectTypeOf(input).toEqualTypeOf<Request>()
        expectTypeOf(request.amount).toEqualTypeOf<string>()
        expectTypeOf(request.currency).toEqualTypeOf<string>()
        expectTypeOf(request.decimals).toEqualTypeOf<number>()
        expectTypeOf(request.recipient).toEqualTypeOf<string>()
        return true
      },
      async verify() {
        return {
          method: 'alpha',
          reference: 'tx',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })
  })

  test('offer selection data is deeply readonly', () => {
    Mppx.create({
      methods: [tip1034SessionMethod, legacySessionMethod],
      realm,
      secretKey,
      selectOffers(offers) {
        expectTypeOf(offers[0]!.method.alias).toEqualTypeOf<undefined | 'sessionLegacy'>()
        // @ts-expect-error offer method descriptors are readonly.
        offers[0]!.method.name = 'changed'
        // @ts-expect-error normalized offer requests are deeply readonly.
        offers[0]!.request.methodDetails.sessionProtocol = 'changed'
        expectTypeOf(offers[0]!.method).not.toHaveProperty('verify')
        return offers
      },
    })

    Method.toServer(mockSession, {
      canOffer({ request }) {
        // @ts-expect-error canOffer requests are deeply readonly.
        request.methodDetails.sessionProtocol = 'changed'
        return true
      },
      async verify() {
        return {
          method: 'tempo',
          reference: 'tx',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })
  })

  test('selectOffers is only available for HTTP transport', () => {
    Mppx.create({
      methods: [alphaMethod],
      realm,
      secretKey,
      transport: Transport.mcp(),
      // @ts-expect-error selectOffers applies to composed HTTP offers only.
      selectOffers: (offers) => offers,
    })
  })

  test('nested handlers are accessible', () => {
    const mppx = Mppx.create({ methods: [alphaMethod, betaMethod], realm, secretKey })

    expectTypeOf(mppx.alpha).toBeObject()
    expectTypeOf(mppx.alpha.charge).toBeFunction()
    expectTypeOf(mppx.beta).toBeObject()
    expectTypeOf(mppx.beta.charge).toBeFunction()
  })

  test('aliased duplicate handlers are accessible by nested and slash keys', () => {
    const mppx = Mppx.create({
      methods: [tip1034SessionMethod, alternateSessionMethod],
      realm,
      secretKey,
    })

    expectTypeOf(mppx.tempo.session).toBeFunction()
    expectTypeOf(mppx.tempo.alternateSession).toBeFunction()
    expectTypeOf(mppx['tempo/session']).toBeFunction()
    expectTypeOf(mppx['tempo/alternateSession']).toBeFunction()
    expectTypeOf(mppx.challenge.tempo.session).toBeFunction()
    expectTypeOf(mppx.challenge.tempo.alternateSession).toBeFunction()
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
    expectTypeOf(_handler._internal?.offers).toMatchTypeOf<readonly unknown[] | undefined>()
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
    expectTypeOf(mppx.broadcastCredential).toBeFunction()
    expectTypeOf(mppx.validateCredential).toBeFunction()
  })

  test('server events receive typed method context', () => {
    const mppx = Mppx.create({
      methods: [alphaMethod],
      realm,
      secretKey,
    })

    mppx.on('payment.success', (context) => {
      expectTypeOf(context.challenge.method).toEqualTypeOf<'alpha'>()
      expectTypeOf(context.credential?.payload.token).toEqualTypeOf<string | undefined>()
    })
    mppx.on('challenge.created', (context) => {
      expectTypeOf(context.method.name).toEqualTypeOf<'alpha'>()
      expectTypeOf(context.error).toMatchTypeOf<Error | undefined>()
    })
    mppx.on('payment.failed', (context) => {
      expectTypeOf(context.error).toMatchTypeOf<Error>()
      expectTypeOf(context.credential).toMatchTypeOf<unknown>()
    })
    mppx.on('*', (event) => {
      expectTypeOf(event.name).toMatchTypeOf<
        'challenge.created' | 'payment.failed' | 'payment.success'
      >()
      if (event.name === 'payment.failed') expectTypeOf(event.payload.error).toMatchTypeOf<Error>()
      if (event.name === 'challenge.created')
        expectTypeOf(event.payload.error).toMatchTypeOf<Error | undefined>()
      if (event.name === 'payment.success')
        expectTypeOf(event.payload.receipt.status).toEqualTypeOf<'success'>()
    })
    mppx.onChallengeCreated((context) => {
      expectTypeOf(context.input).toEqualTypeOf<Request | undefined>()
      expectTypeOf(context.method.name).toEqualTypeOf<'alpha'>()
      expectTypeOf(context.request.amount).toEqualTypeOf<string>()
      expectTypeOf(context.error).toMatchTypeOf<Error | undefined>()
    })
    mppx.onPaymentSuccess((context) => {
      expectTypeOf(context.challenge.method).toEqualTypeOf<'alpha'>()
      expectTypeOf(context.credential?.payload.token).toEqualTypeOf<string | undefined>()
      expectTypeOf(context.envelope?.challenge.intent).toEqualTypeOf<'charge' | undefined>()
      expectTypeOf(context.receipt.status).toEqualTypeOf<'success'>()
      expectTypeOf(context.request.recipient).toEqualTypeOf<string>()
    })
    mppx.onPaymentFailed((context) => {
      expectTypeOf(context.credential).toMatchTypeOf<unknown>()
      expectTypeOf(context.error).toMatchTypeOf<Error>()
      expectTypeOf(context.method.intent).toEqualTypeOf<'charge'>()
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

  test('tempo factories expose resolved currency and decimals as defaults', () => {
    const charge = Mppx.create({ methods: [tempo.charge()], realm, secretKey })
    expectTypeOf(charge.tempo.charge({ amount: '1' })).toBeFunction()
    // @ts-expect-error amount is not supplied by Tempo's runtime defaults.
    void charge.tempo.charge({})

    const subscription = Mppx.create({
      methods: [
        tempo.subscription({
          recipient: '0x1234567890abcdef1234567890abcdef12345678',
          resolve: async () => null,
        }),
      ],
      realm,
      secretKey,
    })
    expectTypeOf(
      subscription.tempo.subscription({
        amount: '1',
        periodCount: 1n,
        periodUnit: 'day',
        subscriptionExpires: new Date('2026-01-01T00:00:00Z'),
      }),
    ).toBeFunction()

    const session = Mppx.create({ methods: [tempo.session()], realm, secretKey })
    expectTypeOf(session.tempo.session({ amount: '1', unitType: 'request' })).toBeFunction()

    const common = Mppx.create({
      methods: [
        tempo.common({
          amount: '1',
          recipient: '0x1234567890abcdef1234567890abcdef12345678',
        }),
      ],
      realm,
      secretKey,
    })
    expectTypeOf(common.tempo.charge({})).toBeFunction()
    expectTypeOf(common.tempo.session({ unitType: 'request' })).toBeFunction()
  })
})
