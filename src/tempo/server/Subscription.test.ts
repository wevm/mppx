import { Challenge, Credential } from 'mppx'
import { Mppx } from 'mppx/server'
import { describe, expect, test } from 'vp/test'

import * as Store from '../../Store.js'
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

describe('tempo.subscription', () => {
  test('stores an activated subscription and reuses it on later requests', async () => {
    const store = Store.memory()
    const method = subscription({
      activate: async ({ request, source }) => ({
        receipt: createReceipt('sub_123', '0xactivate'),
        subscription: {
          amount: request.amount,
          billingAnchor: activeBillingAnchor,
          chainId: request.methodDetails?.chainId,
          currency: request.currency,
          identityId: source?.address ?? 'anon',
          lastChargedPeriod: 0,
          periodSeconds: request.periodSeconds,
          recipient: request.recipient,
          reference: '0xactivate',
          resourceId: 'resource:alpha',
          subscriptionExpires: request.subscriptionExpires,
          subscriptionId: 'sub_123',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
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
          'Subscription-Id': 'sub_123',
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

  test('fails closed when multiple active subscriptions match without a hint', async () => {
    const store = Store.memory()
    const method = subscription({
      activate: async ({ request }) => ({
        receipt: createReceipt('unused'),
        subscription: {
          amount: request.amount,
          billingAnchor: activeBillingAnchor,
          chainId: request.methodDetails?.chainId,
          currency: request.currency,
          identityId: 'user-1',
          lastChargedPeriod: 0,
          periodSeconds: request.periodSeconds,
          recipient: request.recipient,
          reference: 'unused',
          resourceId: 'resource:alpha',
          subscriptionExpires: request.subscriptionExpires,
          subscriptionId: 'unused',
          timestamp: '2025-01-01T00:00:00.000Z',
        },
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

    await store.put('tempo:subscription:record:sub_a', {
      amount: '10000000',
      billingAnchor: activeBillingAnchor,
      chainId: 4217,
      currency: '0x20c0000000000000000000000000000000000001',
      identityId: 'user-1',
      lastChargedPeriod: 0,
      periodSeconds: '3600',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      reference: '0xsuba',
      resourceId: 'resource:alpha',
      subscriptionExpires: activeSubscriptionExpires,
      subscriptionId: 'sub_a',
      timestamp: '2025-01-01T00:00:00.000Z',
    })
    await store.put('tempo:subscription:record:sub_b', {
      amount: '10000000',
      billingAnchor: activeBillingAnchor,
      chainId: 4217,
      currency: '0x20c0000000000000000000000000000000000001',
      identityId: 'user-1',
      lastChargedPeriod: 0,
      periodSeconds: '3600',
      recipient: '0x1234567890abcdef1234567890abcdef12345678',
      reference: '0xsubb',
      resourceId: 'resource:alpha',
      subscriptionExpires: activeSubscriptionExpires,
      subscriptionId: 'sub_b',
      timestamp: '2025-01-01T00:00:00.000Z',
    })
    await store.put('tempo:subscription:resource:user-1:resource:alpha', ['sub_a', 'sub_b'])

    const mppx = Mppx.create({ methods: [method], realm, secretKey })
    const result = await mppx['tempo/subscription']({})(
      new Request('https://example.com/resource'),
    )

    expect(result.status).toBe(402)
    if (result.status !== 402) throw new Error('expected ambiguity challenge')

    const body = (await result.challenge.json()) as { detail: string }
    expect(body.detail).toContain('Multiple active subscriptions match this request')
  })
})
