import { Challenge, Credential, Receipt } from 'mppx'
import { Mppx } from 'mppx/server'
import { describe, expect, test } from 'vp/test'

import * as Store from '../../Store.js'
import * as SubscriptionStore from '../subscription/Store.js'
import type { SubscriptionRecord } from '../subscription/Types.js'
import { charge, subscription } from './Subscription.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'
const activeBillingAnchor = new Date().toISOString()
const activeSubscriptionExpires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000).toISOString()
const subscriptionKey = 'user-1:plan:pro'

function createReceipt(subscriptionId: string, reference = '0xreceipt') {
  return {
    method: 'tempo',
    reference,
    status: 'success',
    subscriptionId,
    timestamp: '2025-01-01T00:00:00.000Z',
  } as const
}

function createRecord(overrides: Partial<SubscriptionRecord> = {}): SubscriptionRecord {
  return {
    amount: '10000000',
    billingAnchor: activeBillingAnchor,
    chainId: 4217,
    currency: '0x20c0000000000000000000000000000000000001',
    lastChargedPeriod: 0,
    lookupKey: subscriptionKey,
    periodSeconds: '3600',
    recipient: '0x1234567890abcdef1234567890abcdef12345678',
    reference: '0xsubscription',
    subscriptionExpires: activeSubscriptionExpires,
    subscriptionId: 'sub_123',
    timestamp: '2025-01-01T00:00:00.000Z',
    ...overrides,
  }
}

describe('tempo.subscription', () => {
  test('stores an activated subscription and reuses it on later requests', async () => {
    const store = Store.memory()
    const method = subscription({
      activate: async ({ request, resolved }) => ({
        receipt: createReceipt('sub_123', '0xactivate'),
        subscription: createRecord({
          amount: request.amount,
          chainId: request.methodDetails?.chainId,
          currency: request.currency,
          lookupKey: resolved.key,
          periodSeconds: request.periodSeconds,
          recipient: request.recipient,
          reference: '0xactivate',
          subscriptionExpires: request.subscriptionExpires,
        }),
      }),
      amount: '10',
      chainId: 4217,
      currency: '0x20c0000000000000000000000000000000000001',
      periodSeconds: '3600',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      resolve: async ({ input }) => {
        const key = input.headers.get('X-Subscription-Key')
        return key ? { key } : null
      },
      store,
      subscriptionExpires: activeSubscriptionExpires,
    })

    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const challengeResult = await mppx['tempo/subscription']({})(
      new Request('https://example.com/resource', {
        headers: { 'X-Subscription-Key': subscriptionKey },
      }),
    )

    expect(challengeResult.status).toBe(402)
    if (challengeResult.status !== 402) throw new Error('expected activation challenge')

    const challenge = Challenge.fromResponse(challengeResult.challenge)
    const credential = Credential.from({
      challenge,
      payload: { signature: '0x1234', type: 'keyAuthorization' },
      source: 'did:pkh:eip155:4217:0x1234567890abcdef1234567890abcdef12345678',
    })

    const activated = await mppx['tempo/subscription']({})(
      new Request('https://example.com/resource', {
        headers: {
          Authorization: Credential.serialize(credential),
          'X-Subscription-Key': subscriptionKey,
        },
      }),
    )

    expect(activated.status).toBe(200)

    const reused = await mppx['tempo/subscription']({})(
      new Request('https://example.com/resource', {
        headers: {
          'X-Subscription-Key': subscriptionKey,
        },
      }),
    )

    expect(reused.status).toBe(200)
    if (reused.status !== 200) throw new Error('expected authorize reuse')

    const response = reused.withReceipt(new Response('OK'))
    const receipt = response.headers.get('Payment-Receipt')
    expect(receipt).toBeTruthy()
  })

  test('new activation replaces the previous subscription for the same lookup key', async () => {
    const store = Store.memory()
    const subscriptions = SubscriptionStore.fromStore(store)

    // Seed an expired subscription so authorize() falls through to a new challenge.
    const expiredDate = new Date(Date.now() - 1_000).toISOString()
    await subscriptions.put(
      createRecord({
        lookupKey: subscriptionKey,
        subscriptionId: 'sub_old',
        reference: '0xold',
        subscriptionExpires: expiredDate,
      }),
    )

    const method = subscription({
      activate: async ({ request, resolved }) => ({
        receipt: createReceipt('sub_new', '0xnew'),
        subscription: createRecord({
          amount: request.amount,
          chainId: request.methodDetails?.chainId,
          currency: request.currency,
          lookupKey: resolved.key,
          periodSeconds: request.periodSeconds,
          recipient: request.recipient,
          reference: '0xnew',
          subscriptionExpires: request.subscriptionExpires,
          subscriptionId: 'sub_new',
        }),
      }),
      amount: '10',
      chainId: 4217,
      currency: '0x20c0000000000000000000000000000000000001',
      periodSeconds: '3600',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      resolve: async () => ({ key: subscriptionKey }),
      store,
      subscriptionExpires: activeSubscriptionExpires,
    })

    const mppx = Mppx.create({ methods: [method], realm, secretKey })

    const challengeResult = await mppx['tempo/subscription']({})(
      new Request('https://example.com/resource'),
    )
    expect(challengeResult.status).toBe(402)
    if (challengeResult.status !== 402) throw new Error('expected challenge')

    const challenge = Challenge.fromResponse(challengeResult.challenge)
    const credential = Credential.from({
      challenge,
      payload: { signature: '0x1234', type: 'keyAuthorization' },
      source: 'did:pkh:eip155:4217:0x1234567890abcdef1234567890abcdef12345678',
    })

    const activated = await mppx['tempo/subscription']({})(
      new Request('https://example.com/resource', {
        headers: {
          Authorization: Credential.serialize(credential),
          'X-Subscription-Key': subscriptionKey,
        },
      }),
    )
    expect(activated.status).toBe(200)
    if (activated.status !== 200) throw new Error('expected activation')

    const receipt = Receipt.fromResponse(activated.withReceipt(new Response('OK')))
    expect(receipt.subscriptionId).toBe('sub_new')

    const current = await subscriptions.getByKey(subscriptionKey)
    expect(current?.subscriptionId).toBe('sub_new')
  })

  test('renews an overdue matching subscription before falling back to 402', async () => {
    const store = Store.memory()
    const subscriptions = SubscriptionStore.fromStore(store)
    const renewCalls: number[] = []
    const method = subscription({
      activate: async () => ({
        receipt: createReceipt('unused'),
        subscription: createRecord({ subscriptionId: 'unused' }),
      }),
      amount: '10',
      chainId: 4217,
      currency: '0x20c0000000000000000000000000000000000001',
      periodSeconds: '3600',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      resolve: async () => ({ key: subscriptionKey }),
      renew: async ({ periodIndex, subscription }) => {
        renewCalls.push(periodIndex)
        return {
          receipt: createReceipt(subscription.subscriptionId, '0xrenewed'),
          subscription: {
            ...subscription,
            lastChargedPeriod: periodIndex,
            reference: '0xrenewed',
          },
        }
      },
      store,
      subscriptionExpires: activeSubscriptionExpires,
    })

    await subscriptions.put(
      createRecord({
        billingAnchor: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        lastChargedPeriod: 0,
        lookupKey: subscriptionKey,
        reference: '0xstale',
        subscriptionId: 'sub_due',
      }),
    )

    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const result = await mppx['tempo/subscription']({})(
      new Request('https://example.com/resource', {
        headers: { 'X-Subscription-Key': subscriptionKey },
      }),
    )

    expect(result.status).toBe(200)
    expect(renewCalls.length).toBe(1)
    expect(renewCalls[0]).toBeGreaterThan(0)
    if (result.status !== 200) throw new Error('expected renewal success')

    const receipt = Receipt.fromResponse(result.withReceipt(new Response('OK')))
    expect(receipt.reference).toBe('0xrenewed')
    expect(receipt.subscriptionId).toBe('sub_due')
  })

  test('charges an overdue subscription outside the request path', async () => {
    const store = Store.memory()
    const subscriptions = SubscriptionStore.fromStore(store)
    const renewCalls: number[] = []

    await subscriptions.put(
      createRecord({
        billingAnchor: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        lastChargedPeriod: 0,
        lookupKey: subscriptionKey,
        reference: '0xstale',
        subscriptionId: 'sub_background',
      }),
    )

    const result = await charge({
      renew: async ({ periodIndex, subscription }) => {
        renewCalls.push(periodIndex)
        return {
          receipt: createReceipt(subscription.subscriptionId, '0xbackground'),
          subscription: {
            ...subscription,
            lastChargedPeriod: periodIndex,
            reference: '0xbackground',
          },
        }
      },
      store,
      subscriptionId: 'sub_background',
    })

    expect(result?.receipt.reference).toBe('0xbackground')
    expect(renewCalls.length).toBe(1)
    expect((await subscriptions.get('sub_background'))?.reference).toBe('0xbackground')
  })
})
