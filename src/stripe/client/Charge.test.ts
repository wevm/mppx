import { Challenge, Credential } from 'mppx'
import { Mppx, stripe } from 'mppx/client'
import { Mppx as Mppx_server, stripe as stripe_server } from 'mppx/server'
import { describe, expect, test, vi } from 'vitest'

import type { StripeJs } from '../internal/types.js'
import { charge as clientCharge_ } from './Charge.js'

const realm = 'api.example.com'
const secretKey = 'test-hmac-key'

const dummyClientCharge = clientCharge_({
  createToken: async () => 'spt_test',
  paymentMethod: 'pm_test',
})

async function createChallenge() {
  const server = Mppx_server.create({
    methods: [
      stripe_server.charge({
        networkId: 'internal',
        paymentMethodTypes: ['card'],
        secretKey: 'sk_test',
      }),
    ],
    realm,
    secretKey,
  })

  const handle = server.charge({ amount: '100', currency: 'usd', decimals: 2 })
  const result = await handle(new Request('https://example.com'))
  if (result.status !== 402) throw new Error('Expected 402')
  return Challenge.fromResponse(result.challenge, { methods: [dummyClientCharge] })
}

function createMockStripeJs(): StripeJs {
  return {
    createPaymentMethod: vi.fn(async () => ({
      error: null,
      paymentMethod: { id: 'pm_mock_123' },
    })),
    elements: vi.fn(() => ({})),
  }
}

describe('stripe.charge client param', () => {
  test('default: forwards client to createToken callback', async () => {
    const mockClient = createMockStripeJs()
    let receivedClient: StripeJs | undefined

    const charge = stripe.charge({
      client: mockClient,
      createToken: async (params) => {
        receivedClient = params.client
        return 'spt_test_123'
      },
      paymentMethod: 'pm_card_visa',
    })

    const challenge = await createChallenge()
    await charge.createCredential({ challenge, context: {} })

    expect(receivedClient).toBe(mockClient)
  })

  test('behavior: client is undefined when not provided', async () => {
    let receivedClient: StripeJs | undefined = createMockStripeJs()

    const charge = stripe.charge({
      createToken: async (params) => {
        receivedClient = params.client
        return 'spt_test_123'
      },
      paymentMethod: 'pm_card_visa',
    })

    const challenge = await createChallenge()
    await charge.createCredential({ challenge, context: {} })

    expect(receivedClient).toBeUndefined()
  })

  test('behavior: createToken receives all expected params', async () => {
    const mockClient = createMockStripeJs()
    let receivedParams: Record<string, unknown> | undefined

    const charge = stripe.charge({
      client: mockClient,
      createToken: async (params) => {
        receivedParams = params as unknown as Record<string, unknown>
        return 'spt_test_123'
      },
      paymentMethod: 'pm_card_visa',
    })

    const challenge = await createChallenge()
    await charge.createCredential({ challenge, context: {} })

    expect(receivedParams).toBeDefined()
    expect(receivedParams!.amount).toBe('10000')
    expect(receivedParams!.currency).toBe('usd')
    expect(receivedParams!.networkId).toBe('internal')
    expect(receivedParams!.paymentMethod).toBe('pm_card_visa')
    expect(receivedParams!.client).toBe(mockClient)
    expect(receivedParams!.challenge).toBeDefined()
    expect(typeof receivedParams!.expiresAt).toBe('number')
  })

  test('behavior: produces valid credential string', async () => {
    const charge = stripe.charge({
      createToken: async () => 'spt_test_123',
      paymentMethod: 'pm_card_visa',
    })

    const challenge = await createChallenge()
    const credential = await charge.createCredential({ challenge, context: {} })

    expect(credential).toMatch(/^Payment /)

    const parsed = Credential.deserialize(credential)
    expect(parsed.payload).toMatchObject({ spt: 'spt_test_123' })
  })

  test('behavior: includes externalId in credential payload', async () => {
    const charge = stripe.charge({
      createToken: async () => 'spt_test_123',
      externalId: 'order_456',
      paymentMethod: 'pm_card_visa',
    })

    const challenge = await createChallenge()
    const credential = await charge.createCredential({ challenge, context: {} })
    const parsed = Credential.deserialize(credential)
    expect(parsed.payload).toMatchObject({
      externalId: 'order_456',
      spt: 'spt_test_123',
    })
  })

  test('behavior: context paymentMethod overrides default', async () => {
    let receivedPaymentMethod: string | undefined

    const charge = stripe.charge({
      createToken: async (params) => {
        receivedPaymentMethod = params.paymentMethod
        return 'spt_test_123'
      },
      paymentMethod: 'pm_default',
    })

    const challenge = await createChallenge()
    await charge.createCredential({
      challenge,
      context: { paymentMethod: 'pm_override' },
    })

    expect(receivedPaymentMethod).toBe('pm_override')
  })

  test('behavior: Mppx.create with client forwards through createCredential', async () => {
    const mockClient = createMockStripeJs()
    let receivedClient: StripeJs | undefined

    const mppx = Mppx.create({
      methods: [
        stripe.charge({
          client: mockClient,
          createToken: async (params) => {
            receivedClient = params.client
            return 'spt_test_123'
          },
          paymentMethod: 'pm_card_visa',
        }),
      ],
      polyfill: false,
    })

    const challenge = await createChallenge()
    const response = new Response(null, {
      status: 402,
      headers: {
        'WWW-Authenticate': Challenge.serialize(challenge),
      },
    })

    await mppx.createCredential(response)

    expect(receivedClient).toBe(mockClient)
  })
})
