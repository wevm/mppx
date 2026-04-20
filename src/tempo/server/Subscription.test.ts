import { Challenge, Credential, Receipt } from 'mppx'
import { Mppx } from 'mppx/server'
import { describe, expect, test } from 'vp/test'

import * as Store from '../../Store.js'
import type { SubscriptionRecord } from '../subscription/Types.js'
import { subscription } from './Subscription.js'

const realm = 'api.example.com'
const secretKey = 'test-secret-key'
const activeBillingAnchor = new Date().toISOString()
const activeSubscriptionExpires = new Date(Date.now() + 365 * 24 * 60 * 60 * 1_000).toISOString()

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
    identityId: 'user-1',
    lastChargedPeriod: 0,
    periodSeconds: '3600',
    recipient: '0x1234567890abcdef1234567890abcdef12345678',
    reference: '0xsubscription',
    resourceId: 'resource:alpha',
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
      activate: async ({ request, source }) => ({
        receipt: createReceipt('sub_123', '0xactivate'),
        subscription: createRecord({
          amount: request.amount,
          chainId: request.methodDetails?.chainId,
          currency: request.currency,
          identityId: source?.address ?? 'anon',
          periodSeconds: request.periodSeconds,
          recipient: request.recipient,
          reference: '0xactivate',
          subscriptionExpires: request.subscriptionExpires,
        }),
      }),
      amount: '10',
      chainId: 4217,
      currency: '0x20c0000000000000000000000000000000000001',
      getIdentity: async ({ input }) => ({ id: input.headers.get('X-User') ?? 'anon' }),
      getResource: async () => ({ id: 'resource:alpha' }),
      periodSeconds: '3600',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      store,
      subscriptionExpires: activeSubscriptionExpires,
    })

    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const challengeResult = await mppx['tempo/subscription']({})(
      new Request('https://example.com/resource', { headers: { 'X-User': 'user-1' } }),
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
          'X-User': '0x1234567890abcdef1234567890abcdef12345678',
        },
      }),
    )

    expect(activated.status).toBe(200)

    const reused = await mppx['tempo/subscription']({})(
      new Request('https://example.com/resource', {
        headers: {
          'X-User': '0x1234567890abcdef1234567890abcdef12345678',
        },
      }),
    )

    expect(reused.status).toBe(200)
    if (reused.status !== 200) throw new Error('expected authorize reuse')

    const response = reused.withReceipt(new Response('OK'))
    const receipt = response.headers.get('Payment-Receipt')
    expect(receipt).toBeTruthy()
  })

  test('new activation replaces previous subscription for same resource', async () => {
    const store = Store.memory()

    // Seed an expired subscription so authorize() falls through to a new challenge.
    const expiredDate = new Date(Date.now() - 1_000).toISOString()
    await store.put('tempo:subscription:record:sub_old', createRecord({
      subscriptionId: 'sub_old',
      reference: '0xold',
      subscriptionExpires: expiredDate,
    }))
    await store.put('tempo:subscription:resource:user-1:resource:alpha', 'sub_old')

    const method = subscription({
      activate: async ({ request, source }) => ({
        receipt: createReceipt('sub_new', '0xnew'),
        subscription: createRecord({
          amount: request.amount,
          chainId: request.methodDetails?.chainId,
          currency: request.currency,
          identityId: source?.address ?? 'anon',
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
      getIdentity: async () => ({ id: 'user-1' }),
      getResource: async () => ({ id: 'resource:alpha' }),
      periodSeconds: '3600',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
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
        headers: { Authorization: Credential.serialize(credential) },
      }),
    )
    expect(activated.status).toBe(200)
    if (activated.status !== 200) throw new Error('expected activation')

    const receipt = Receipt.fromResponse(activated.withReceipt(new Response('OK')))
    expect(receipt.subscriptionId).toBe('sub_new')
  })

  test('renews an overdue matching subscription before falling back to 402', async () => {
    const store = Store.memory()
    const renewCalls: number[] = []
    const method = subscription({
      activate: async () => ({
        receipt: createReceipt('unused'),
        subscription: createRecord({ subscriptionId: 'unused' }),
      }),
      amount: '10',
      chainId: 4217,
      currency: '0x20c0000000000000000000000000000000000001',
      getIdentity: async () => ({ id: 'user-1' }),
      getResource: async () => ({ id: 'resource:alpha' }),
      periodSeconds: '3600',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
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

    await store.put(
      'tempo:subscription:record:sub_due',
      createRecord({
        billingAnchor: new Date(Date.now() - 3 * 3_600_000).toISOString(),
        lastChargedPeriod: 0,
        reference: '0xstale',
        subscriptionId: 'sub_due',
      }),
    )
    await store.put('tempo:subscription:resource:user-1:resource:alpha', 'sub_due')

    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const result = await mppx['tempo/subscription']({})(new Request('https://example.com/resource'))

    expect(result.status).toBe(200)
    expect(renewCalls.length).toBe(1)
    expect(renewCalls[0]).toBeGreaterThan(0)
    if (result.status !== 200) throw new Error('expected renewal success')

    const receipt = Receipt.fromResponse(result.withReceipt(new Response('OK')))
    expect(receipt.reference).toBe('0xrenewed')
    expect(receipt.subscriptionId).toBe('sub_due')
  })

})
