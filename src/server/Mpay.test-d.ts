import { describe, expectTypeOf, test } from 'vitest'
import * as Intent from '../Intent.js'
import * as Method from '../Method.js'
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

const fooMethod = Method.from({
  name: 'test',
  intents: { charge: fooCharge },
})

describe('Mpay', () => {
  test('has method and realm properties', () => {
    const method = Method.toServer(fooMethod, {
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
      method,
      realm: 'api.example.com',
      secretKey: 'secret',
    })

    expectTypeOf(handler.method).toEqualTypeOf(method)
    expectTypeOf(handler.realm).toBeString()
  })

  test('has intent functions matching method intents', () => {
    const baseMethod = Method.from({
      name: 'test',
      intents: {
        charge: fooCharge,
      },
    })

    const method = Method.toServer(baseMethod, {
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
      method,
      realm: 'api.example.com',
      secretKey: 'secret',
    })

    expectTypeOf(handler.charge).toBeFunction()
  })

  test('intent function options include request', () => {
    const method = Method.toServer(fooMethod, {
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
      method,
      realm: 'api.example.com',
      secretKey: 'secret',
    })

    handler.charge({
      amount: '1000',
      currency: '0x1234',
      expires: '2025-01-01T00:00:00Z',
      recipient: '0xabc',
    })
  })

  test('intent function options include context when method has context', () => {
    const method = Method.toServer(fooMethod, {
      context: z.object({ rpcUrl: z.string() }),
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
      method,
      realm: 'api.example.com',
      secretKey: 'secret',
    })

    handler.charge({
      amount: '1000',
      currency: '0x1234',
      expires: '2025-01-01T00:00:00Z',
      recipient: '0xabc',
      rpcUrl: 'https://rpc.example.com',
    })
  })

  test('intent function returns handler that accepts Request', async () => {
    const method = Method.toServer(fooMethod, {
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
      method,
      realm: 'api.example.com',
      secretKey: 'secret',
    })

    const chargeHandler = handler.charge({
      amount: '1000',
      currency: '0x1234',
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
})

describe('create.Config', () => {
  test('requires method, realm, and secretKey', () => {
    type Config = Mpay.create.Config

    expectTypeOf<Config>().toHaveProperty('method')
    expectTypeOf<Config>().toHaveProperty('realm')
    expectTypeOf<Config>().toHaveProperty('secretKey')
  })
})
