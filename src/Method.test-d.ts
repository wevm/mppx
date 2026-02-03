import { assertType, describe, expectTypeOf, test } from 'vitest'
import * as Intent from './Intent.js'
import * as Method from './Method.js'
import * as MethodIntent from './MethodIntent.js'
import * as zod from './zod.js'

const fooCharge = MethodIntent.fromIntent(Intent.charge, {
  method: 'test',
  schema: {
    credential: {
      payload: zod.object({ signature: zod.string() }),
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

describe('NameOf', () => {
  test('extracts method name', () => {
    const baseMethod = Method.from({
      name: 'tempo',
      intents: { charge: fooCharge },
    })

    const method = Method.toServer(baseMethod, {
      async verify() {
        return {
          method: 'tempo',
          reference: '0x123',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })

    type Name = Method.NameOf<typeof method>
    assertType<Name>('tempo' as const)
  })
})

describe('IntentsOf', () => {
  test('extracts intents map', () => {
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

    type Intents = Method.IntentsOf<typeof method>
    expectTypeOf<Intents>().toHaveProperty('charge')
  })
})

describe('ContextOf', () => {
  test('returns empty object when no context', () => {
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

    type Context = Method.ContextOf<typeof method>
    expectTypeOf<Context>().toEqualTypeOf<Record<never, never>>()
  })

  test('extracts context input type', () => {
    const method = Method.toServer(fooMethod, {
      context: zod.object({ apiKey: zod.string(), debug: zod.optional(zod.boolean()) }),
      async verify() {
        return {
          method: 'test',
          reference: '0x123',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })

    type Context = Method.ContextOf<typeof method>
    expectTypeOf<Context>().toHaveProperty('apiKey')
    expectTypeOf<Context['apiKey']>().toBeString()
  })
})

describe('toServer', () => {
  test('infers name as literal', () => {
    const baseMethod = Method.from({
      name: 'custom',
      intents: { charge: fooCharge },
    })

    const method = Method.toServer(baseMethod, {
      async verify() {
        return {
          method: 'custom',
          reference: '0x123',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })

    assertType<'custom'>(method.name)
  })

  test('infers intents correctly', () => {
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

    expectTypeOf(method.intents.charge).toMatchTypeOf<MethodIntent.MethodIntent>()
  })

  test('verify receives typed parameters', () => {
    Method.toServer(fooMethod, {
      context: zod.object({ rpcUrl: zod.string() }),
      async verify({ context, credential }) {
        expectTypeOf(context).toHaveProperty('rpcUrl')
        expectTypeOf(context.rpcUrl).toBeString()
        expectTypeOf(credential.payload).toHaveProperty('signature')
        return {
          method: 'test',
          reference: '0x123',
          status: 'success' as const,
          timestamp: new Date().toISOString(),
        }
      },
    })
  })
})
