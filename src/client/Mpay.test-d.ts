import type { Account } from 'viem'
import { describe, expectTypeOf, test } from 'vitest'
import * as MethodIntent from '../MethodIntent.js'
import { charge } from '../tempo/client/Charge.js'
import * as Intents from '../tempo/Intents.js'
import * as z from '../zod.js'
import * as Mpay from './Mpay.js'

describe('Mpay', () => {
  test('has methods array', () => {
    const method = charge({
      account: {} as Account,
    })
    const mpay = Mpay.create({ methods: [method] })

    expectTypeOf(mpay.methods).toMatchTypeOf<readonly MethodIntent.AnyClient[]>()
    expectTypeOf(mpay.methods[0]?.name).toEqualTypeOf<'charge'>()
  })

  test('has createCredential function', () => {
    const method = charge({
      account: {} as Account,
    })
    const mpay = Mpay.create({ methods: [method] })

    expectTypeOf(mpay.createCredential).toBeFunction()
    expectTypeOf(mpay.createCredential).returns.toMatchTypeOf<Promise<string>>()
  })
})

describe('create.Config', () => {
  test('requires methods array', () => {
    type Config = Mpay.create.Config

    expectTypeOf<Config>().toHaveProperty('methods')
  })
})

describe('Method.toClient', () => {
  test('createCredential receives typed challenge', () => {
    MethodIntent.toClient(Intents.charge, {
      async createCredential({ challenge }) {
        expectTypeOf(challenge.method).toBeString()
        expectTypeOf(challenge.intent).toBeString()
        expectTypeOf(challenge.request).toHaveProperty('amount')
        expectTypeOf(challenge.request).toHaveProperty('currency')
        expectTypeOf(challenge.request).toHaveProperty('recipient')

        return 'Payment ...'
      },
    })
  })

  test('createCredential receives typed context when provided', () => {
    MethodIntent.toClient(Intents.charge, {
      context: z.object({
        account: z.custom<Account>(),
        extra: z.optional(z.string()),
      }),
      async createCredential({ context }) {
        expectTypeOf(context.account).toEqualTypeOf<Account>()
        expectTypeOf(context.extra).toEqualTypeOf<string | undefined>()

        return 'Payment ...'
      },
    })
  })
})

describe('Mpay with context', () => {
  test('createCredential accepts context matching method schema', () => {
    const method = charge()

    const mpay = Mpay.create({ methods: [method] })

    expectTypeOf(mpay.createCredential).toBeFunction()
    expectTypeOf(mpay.createCredential).returns.toMatchTypeOf<Promise<string>>()
  })

  test('createCredential context is optional when account provided at creation', () => {
    const method = charge({
      account: {} as Account,
    })

    const mpay = Mpay.create({ methods: [method] })

    expectTypeOf(mpay.createCredential).toBeFunction()
    expectTypeOf(mpay.createCredential).returns.toMatchTypeOf<Promise<string>>()
  })
})
