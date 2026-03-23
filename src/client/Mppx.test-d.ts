import type { Account } from 'viem'
import { describe, expectTypeOf, test } from 'vitest'

import * as Method from '../Method.js'
import { charge } from '../tempo/client/Charge.js'
import { tempo } from '../tempo/client/Methods.js'
import type * as AutoSwap from '../tempo/internal/auto-swap.js'
import * as Methods from '../tempo/Methods.js'
import * as z from '../zod.js'
import * as Mppx from './Mppx.js'

describe('Mppx', () => {
  test('has methods array', () => {
    const method = charge({
      account: {} as Account,
    })
    const mppx = Mppx.create({ methods: [method] })

    expectTypeOf(mppx.methods).toMatchTypeOf<readonly Method.AnyClient[]>()
    expectTypeOf(mppx.methods[0]?.intent).toEqualTypeOf<'charge'>()
  })

  test('has createCredential function', () => {
    const method = charge({
      account: {} as Account,
    })
    const mppx = Mppx.create({ methods: [method] })

    expectTypeOf(mppx.createCredential).toBeFunction()
    expectTypeOf(mppx.createCredential).returns.toMatchTypeOf<Promise<string>>()
  })

  test('has rawFetch with standard fetch signature', () => {
    const method = charge({
      account: {} as Account,
    })
    const mppx = Mppx.create({ methods: [method] })

    expectTypeOf(mppx.rawFetch).toEqualTypeOf<typeof globalThis.fetch>()
  })
})

describe('create.Config', () => {
  test('requires methods array', () => {
    type Config = Mppx.create.Config

    expectTypeOf<Config>().toHaveProperty('methods')
  })
})

describe('Method.toClient', () => {
  test('createCredential receives typed challenge', () => {
    Method.toClient(Methods.charge, {
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
    Method.toClient(Methods.charge, {
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

describe('Mppx with context', () => {
  test('createCredential accepts context matching method schema', () => {
    const method = charge()

    const mppx = Mppx.create({ methods: [method] })

    expectTypeOf(mppx.createCredential).toBeFunction()
    expectTypeOf(mppx.createCredential).returns.toMatchTypeOf<Promise<string>>()
  })

  test('createCredential context is optional when account provided at creation', () => {
    const method = charge({
      account: {} as Account,
    })

    const mppx = Mppx.create({ methods: [method] })

    expectTypeOf(mppx.createCredential).toBeFunction()
    expectTypeOf(mppx.createCredential).returns.toMatchTypeOf<Promise<string>>()
  })
})

describe('fetch context', () => {
  test('context has typed account and autoSwap for tempo charge', () => {
    const _mppx = Mppx.create({ methods: [charge()] })

    type FetchInit = NonNullable<Parameters<typeof _mppx.fetch>[1]>
    type Context = NonNullable<FetchInit['context']>

    expectTypeOf<Context>().toHaveProperty('account')
    expectTypeOf<Context>().toHaveProperty('autoSwap')

    expectTypeOf<Context['autoSwap']>().toEqualTypeOf<AutoSwap.resolve.Value | undefined>()
  })

  test('context has typed account and autoSwap for tempo()', () => {
    const _mppx = Mppx.create({ methods: [tempo()] })

    type FetchInit = NonNullable<Parameters<typeof _mppx.fetch>[1]>
    type Context = NonNullable<FetchInit['context']>

    // Context is a union of charge and session contexts.
    // `account` exists on both; `autoSwap` only on charge.
    expectTypeOf<Context>().toHaveProperty('account')
    expectTypeOf<Extract<Context, { autoSwap?: unknown }>>().toHaveProperty('autoSwap')
  })
})
