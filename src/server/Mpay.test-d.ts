import { tempo } from 'mpay/server'
import { describe, expectTypeOf, test } from 'vitest'
import * as Intent from '../Intent.js'
import * as MethodIntent from '../MethodIntent.js'
import * as z from '../zod.js'
import * as Mpay from './Mpay.js'

const fooCharge = MethodIntent.fromIntent(Intent.charge, {
  method: 'test',
  schema: {
    credential: {
      payload: z.object({ signature: z.string() }),
    },
    request: {
      requires: ['recipient'],
    },
  },
})

describe('Mpay', () => {
  test('has methods and realm properties', () => {
    const method = MethodIntent.toServer(fooCharge, {
      async verify() {
        return {
          method: 'test',
          reference: '0x123',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })

    const handler = Mpay.create({
      methods: [method],
      realm: 'api.example.com',
      secretKey: 'secret',
    })

    expectTypeOf(handler.methods).toEqualTypeOf([method] as const)
    expectTypeOf(handler.realm).toBeString()
  })

  test('has intent functions matching method intents', () => {
    const method = MethodIntent.toServer(fooCharge, {
      async verify() {
        return {
          method: 'test',
          reference: '0x123',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })

    const handler = Mpay.create({
      methods: [method],
      realm: 'api.example.com',
      secretKey: 'secret',
    })

    expectTypeOf(handler.charge).toBeFunction()
  })

  test('intent function options include request', () => {
    const method = MethodIntent.toServer(fooCharge, {
      async verify() {
        return {
          method: 'test',
          reference: '0x123',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })

    const handler = Mpay.create({
      methods: [method],
      realm: 'api.example.com',
      secretKey: 'secret',
    })

    handler.charge({
      amount: '1000',
      currency: '0x1234',
      decimals: 6,
      expires: '2025-01-01T00:00:00Z',
      recipient: '0xabc',
    })
  })

  test('intent function returns handler that accepts Request', async () => {
    const method = MethodIntent.toServer(fooCharge, {
      async verify() {
        return {
          method: 'test',
          reference: '0x123',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })

    const handler = Mpay.create({
      methods: [method],
      realm: 'api.example.com',
      secretKey: 'secret',
    })

    const chargeHandler = handler.charge({
      amount: '1000',
      currency: '0x1234',
      decimals: 6,
      expires: '2025-01-01T00:00:00Z',
      recipient: '0xabc',
    })

    const result = await chargeHandler(new Request('https://example.com'))

    if (result.status === 402) {
      expectTypeOf(result.challenge).toEqualTypeOf<Response>()
    } else {
      expectTypeOf(result.withReceipt).toBeFunction()
    }
  })

  test('multiple method intents', () => {
    const authorize = Intent.from({
      name: 'authorize',
      schema: {
        request: z.object({
          scope: z.string(),
          duration: z.number(),
        }),
      },
    })

    const fooAuthorize = MethodIntent.fromIntent(authorize, {
      method: 'test',
      schema: {
        credential: {
          payload: z.object({ token: z.string() }),
        },
      },
    })

    const chargeMethod = MethodIntent.toServer(fooCharge, {
      defaults: {
        currency: '0x1234',
        recipient: '0xabc',
      },
      async verify() {
        return {
          method: 'test',
          reference: '0x123',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })

    const authorizeMethod = MethodIntent.toServer(fooAuthorize, {
      async verify() {
        return {
          method: 'test',
          reference: '0x456',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })

    const handler = Mpay.create({
      methods: [chargeMethod, authorizeMethod],
      realm: 'api.example.com',
      secretKey: 'secret',
    })

    handler.charge({
      amount: '1000',
      currency: '0x1234',
      decimals: 6,
      recipient: '0xabc',
    })

    handler.authorize({
      scope: 'read',
      duration: 3600,
    })
  })

  describe('defaults', () => {
    test('defaulted fields are optional in intent options', () => {
      const handler = Mpay.create({
        methods: [tempo({ currency: '0x1234', recipient: '0xabc' })],
        realm: 'api.example.com',
        secretKey: 'secret',
      })

      // currency and recipient should be optional since they're in defaults
      handler.charge({
        amount: '1000',
        decimals: 6,
      })

      // But can still be overridden
      handler.charge({
        amount: '1000',
        currency: '0x5678',
        decimals: 6,
        recipient: '0xdef',
      })
    })

    test('non-defaulted fields remain required', () => {
      const handler = Mpay.create({
        methods: [tempo({ currency: '0x1234' })],
        realm: 'api.example.com',
        secretKey: 'secret',
      })

      // recipient is still required since it's not in defaults
      handler.charge({
        amount: '1000',
        decimals: 6,
        recipient: '0xabc',
      })
    })

    test('no defaults means all fields required', () => {
      const handler = Mpay.create({
        methods: [tempo({})],
        realm: 'api.example.com',
        secretKey: 'secret',
      })

      // All required fields must be provided
      handler.charge({
        amount: '1000',
        currency: '0x1234',
        decimals: 6,
        recipient: '0xabc',
      })
    })

    test('type: defaulted fields are optional in options type', () => {
      const handler = Mpay.create({
        methods: [tempo({ currency: '0x1234', recipient: '0xabc' })],
        realm: 'api.example.com',
        secretKey: 'secret',
      })

      type ChargeOptions = Parameters<typeof handler.charge>[0]

      // currency and recipient should be optional (include undefined)
      expectTypeOf<ChargeOptions['currency']>().toEqualTypeOf<string | undefined>()
      expectTypeOf<ChargeOptions['recipient']>().toEqualTypeOf<string | undefined>()

      // amount should still be required (no undefined)
      expectTypeOf<ChargeOptions['amount']>().toEqualTypeOf<string>()
    })
  })
})

describe('create.Config', () => {
  test('requires methods, realm, and secretKey', () => {
    type Config = Mpay.create.Config

    expectTypeOf<Config>().toHaveProperty('methods')
    expectTypeOf<Config>().toHaveProperty('realm')
    expectTypeOf<Config>().toHaveProperty('secretKey')
  })
})
