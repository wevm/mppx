import type { Client } from 'viem'
import { expectTypeOf, test } from 'vp/test'

import * as Mppx from '../../server/Mppx.js'
import type { AtomicStore } from '../../Store.js'
import { stripe } from './Methods.js'

test('async defaultMethods() produces types compose can use', async () => {
  const mp = stripe.create({ client: {} as any, networkId: 'profile_x', livemode: false })
  const methods = await mp.defaultMethods()
  const mppx = Mppx.create({ methods, secretKey: 'test' })

  const result = await mppx.compose(
    [
      'tempo/charge',
      {
        amount: '0.01',
        description: 'test',
        paymentIntentOptions({ challenge, credential }: stripe.ResolvePaymentIntentOptionsContext) {
          expectTypeOf(challenge.id).toEqualTypeOf<string>()
          expectTypeOf(credential.challenge.id).toEqualTypeOf<string>()
          return {
            customer: 'cus_123',
            hooks: { inputs: { tax: { calculation: 'taxcalc_123' } } },
            metadata: { key: 'value' },
            receipt_email: 'customer@example.com',
          }
        },
      },
    ],
    [
      'stripe/charge',
      {
        amount: '0.50',
        currency: 'usd',
        decimals: 2,
        description: 'test',
        paymentIntentOptions: { customer: 'cus_123' },
      },
    ],
  )(new Request('http://localhost'))

  expectTypeOf(result.status).toEqualTypeOf<200 | 402>()
})

test('tempo.session() accepts getClient, feePayer, store without casts', () => {
  const mp = stripe.create({ client: {} as any, networkId: 'profile_x', livemode: false })
  const addr = '' as stripe.DepositAddress<'tempo'>

  const session = mp.tempo.session({
    recipient: addr,
    getClient: () => ({}) as Client,
    feePayer: {
      url: 'https://api.tempo.xyz/rpc/sponsor',
      headers: { Authorization: 'Bearer test' },
    },
    store: {} as AtomicStore,
    sse: true,
    settlementSchedule: { amount: '0.01' },
    onSessionSettlement: async () => {},
  })

  expectTypeOf(session).toHaveProperty('name')
  expectTypeOf(session).toHaveProperty('intent')
})

test('stripe.create() accepts hosted fee-payer opt-in', () => {
  const mp = stripe.create({
    client: {} as any,
    networkId: 'profile_x',
    livemode: true,
    hostedFeePayer: true,
  })

  expectTypeOf(mp.defaultMethods()).toHaveProperty('additional')
})

test('.charge() works with multiple charge methods (implicit compose)', async () => {
  const mp = stripe.create({ client: {} as any, networkId: 'profile_x', livemode: false })
  const methods = await mp.defaultMethods()
  const mppx = Mppx.create({ methods, secretKey: 'test' })

  expectTypeOf(mppx.charge).toBeFunction()
  expectTypeOf(mppx.charge).not.toBeNullable()

  // Note: MultiMethodFn options are permissive (UnionToIntersection of any-based schemas).
  // Negative assertions for .charge() options require concrete method schemas to be useful.
})

test('stripe.create() rejects invalid parameters', () => {
  // @ts-expect-error - livemode is required
  stripe.create({ client: {} as any, networkId: 'x' })
  // @ts-expect-error - networkId is required
  stripe.create({ client: {} as any, livemode: true })
  stripe.create({
    client: {} as any,
    networkId: 'x',
    livemode: true,
    // @ts-expect-error - unsupported network key
    depositAddresses: { ethereum: '0x' },
  })
})

test('additional() rejects unsupported network keys', async () => {
  const mp = stripe.create({ client: {} as any, networkId: 'profile_x', livemode: false })
  // @ts-expect-error - 'arbitrum' is not a supported custom rail network
  await mp.defaultMethods().additional({ arbitrum: (_addr) => ({}) as any })
})

test('additional() accepts tempo.session and base with full params', async () => {
  const mp = stripe.create({ client: {} as any, networkId: 'profile_x', livemode: false })
  const methods = await mp.defaultMethods().additional({
    base: {
      x402: { facilitator: { verify: async () => ({}) as any, settle: async () => ({}) as any } },
    },
    tempo: {
      session: {
        store: {} as AtomicStore,
        sse: true,
        settlementSchedule: { amount: '0.01' },
        onSessionSettlement: async () => {},
        getClient: () => ({}) as Client,
      },
    },
  })

  const mppx = Mppx.create({ methods, secretKey: 'test' })
  expectTypeOf(mppx.charge).toBeFunction()
  expectTypeOf(mppx.charge).not.toBeNullable()
})

test('sync defaultMethods() with static depositAddresses returns SyncMethodsResult', () => {
  const mp = stripe.create({
    client: {} as any,
    networkId: 'profile_x',
    livemode: false,
    depositAddresses: { tempo: '0x123' },
  })
  const methods = mp.defaultMethods()
  expectTypeOf(methods).toHaveProperty('additional')

  const mppx = Mppx.create({ methods, secretKey: 'test' })
  expectTypeOf(mppx.charge).toBeFunction()
  expectTypeOf(mppx.charge).not.toBeNullable()
})

test('no depositAddresses returns SyncMethodsResult', () => {
  const mp = stripe.create({
    client: {} as any,
    networkId: 'profile_x',
    livemode: false,
  })
  const methods = mp.defaultMethods()
  expectTypeOf(methods).toHaveProperty('additional')

  const mppx = Mppx.create({ methods, secretKey: 'test' })
  expectTypeOf(mppx.charge).toBeFunction()
})

test('depositAddresses as resolver function returns DefaultMethodsBuilder', async () => {
  const mp = stripe.create({
    client: {} as any,
    networkId: 'profile_x',
    livemode: false,
    depositAddresses: async (_network) => '0xaddr',
  })
  const methods = await mp.defaultMethods()
  const mppx = Mppx.create({ methods, secretKey: 'test' })
  expectTypeOf(mppx.charge).toBeFunction()
})

test('connect config with stripeAccount passes to Mppx.create', async () => {
  const mp = stripe.create({
    client: {} as any,
    networkId: 'profile_x',
    livemode: true,
    connect: { stripeAccount: 'acct_123', applicationFeeAmount: 100 },
  })
  const methods = await mp.defaultMethods()
  const mppx = Mppx.create({ methods, secretKey: 'test' })
  expectTypeOf(mppx.charge).toBeFunction()
})

test('additional() with custom rail (solana) works via compose', async () => {
  const mp = stripe.create({ client: {} as any, networkId: 'profile_x', livemode: false })
  const methods = await mp.defaultMethods().additional({
    base: {
      x402: { facilitator: { verify: async () => ({}) as any, settle: async () => ({}) as any } },
    },
    solana: (_address) => ({
      name: 'solana' as const,
      intent: 'charge' as const,
      schema: { credential: { payload: {} as any }, request: {} as any },
      verify: async () =>
        ({ method: 'solana', status: 'success', reference: '0x', timestamp: '' }) as const,
    }),
  })

  const mppx = Mppx.create({ methods, secretKey: 'test' })

  const result = await mppx.compose(
    ['tempo/charge', { amount: '0.01', description: 'test' }],
    ['evm/charge', { amount: '0.01', description: 'test' }],
    ['solana/charge', { amount: '10000', description: 'test' }] as any,
    ['stripe/charge', { amount: '0.50', currency: 'usd', decimals: 2, description: 'test' }],
  )(new Request('http://localhost'))

  expectTypeOf(result.status).toEqualTypeOf<200 | 402>()
})
