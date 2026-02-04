import type { Account } from 'viem'
import { describe, expectTypeOf, test } from 'vitest'
import * as Method from '../Method.js'
import * as tempo_client from '../tempo/client/Method.js'
import { tempo } from '../tempo/Method.js'
import * as z from '../zod.js'
import * as Mpay from './Mpay.js'

describe('Mpay', () => {
  test('has methods array', () => {
    const method = tempo_client.tempo({
      account: {} as Account,
    })
    const mpay = Mpay.create({ methods: [method] })

    expectTypeOf(mpay.methods).toMatchTypeOf<readonly unknown[]>()
    expectTypeOf(mpay.methods[0]?.name).toEqualTypeOf<'tempo'>()
  })

  test('has createCredential function', () => {
    const method = tempo_client.tempo({
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
    Method.toClient(tempo, {
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

  test('returns Client type', () => {
    const client = Method.toClient(tempo, {
      async createCredential() {
        return 'Payment ...'
      },
    })

    expectTypeOf(client.name).toEqualTypeOf<'tempo'>()
    expectTypeOf(client.intents).toHaveProperty('charge')
    expectTypeOf(client.createCredential).toBeFunction()
  })

  test('createCredential receives typed context when provided', () => {
    Method.toClient(tempo, {
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

  test('returns Client type with context', () => {
    const client = Method.toClient(tempo, {
      context: z.object({
        account: z.custom<Account>(),
      }),
      async createCredential({ context }) {
        return `Payment ${context.account.address}`
      },
    })

    expectTypeOf(client.name).toEqualTypeOf<'tempo'>()
    expectTypeOf(client.context).not.toBeUndefined()
  })
})

describe('Mpay with context', () => {
  test('createCredential accepts context matching method schema', () => {
    const method = tempo_client.tempo()

    const mpay = Mpay.create({ methods: [method] })

    expectTypeOf(mpay.createCredential).toBeFunction()
    expectTypeOf(mpay.createCredential).returns.toMatchTypeOf<Promise<string>>()
  })

  test('createCredential context is optional when account provided at creation', () => {
    const method = tempo_client.tempo({
      account: {} as Account,
    })

    const mpay = Mpay.create({ methods: [method] })

    expectTypeOf(mpay.createCredential).toBeFunction()
    expectTypeOf(mpay.createCredential).returns.toMatchTypeOf<Promise<string>>()
  })
})
