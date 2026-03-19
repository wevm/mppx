import { Challenge, Credential } from 'mppx'
import { Mppx, whop } from 'mppx/client'
import { Mppx as Mppx_server, whop as whop_server } from 'mppx/server'
import { describe, expect, test, vi } from 'vitest'
import { charge as clientCharge_ } from './Charge.js'

const realm = 'api.example.com'
const secretKey = 'test-hmac-key'

function createMockWhopClient() {
  return {
    payments: {
      retrieve: vi.fn(async () => ({
        id: 'pay_mock_123',
        status: 'paid',
        total: 5.0,
        subtotal: 5.0,
        currency: 'usd',
      })),
    },
    checkoutConfigurations: {
      create: vi.fn(async () => ({
        id: 'ch_mock_123',
        purchase_url: 'https://whop.com/checkout/plan_xxx/?session=ch_mock_123',
      })),
    },
  }
}

const dummyClientCharge = clientCharge_({
  completeCheckout: async () => 'pay_mock_123',
})

async function createChallenge() {
  const mockClient = createMockWhopClient()
  const server = Mppx_server.create({
    methods: [
      whop_server({
        client: mockClient,
        companyId: 'biz_test',
        currency: 'usd',
      }),
    ],
    realm,
    secretKey,
  })

  const handle = server.charge({
    amount: 5.0,
    meta: { purchase_url: 'https://whop.com/checkout/test' },
  })
  const result = await handle(new Request('https://example.com'))
  if (result.status !== 402) throw new Error('Expected 402')
  return Challenge.fromResponse(result.challenge, { methods: [dummyClientCharge] })
}

describe('whop.charge client', () => {
  test('behavior: calls completeCheckout with challenge data', async () => {
    let receivedParams: Record<string, unknown> | undefined

    const charge = whop.charge({
      completeCheckout: async (params) => {
        receivedParams = params as unknown as Record<string, unknown>
        return 'pay_test_123'
      },
    })

    const challenge = await createChallenge()
    await charge.createCredential({ challenge, context: {} })

    expect(receivedParams).toBeDefined()
    expect(receivedParams!.amount).toBe(5.0)
    expect(receivedParams!.currency).toBe('usd')
    expect(typeof receivedParams!.purchaseUrl).toBe('string')
  })

  test('behavior: produces valid credential string', async () => {
    const charge = whop.charge({
      completeCheckout: async () => 'pay_test_456',
    })

    const challenge = await createChallenge()
    const credential = await charge.createCredential({ challenge, context: {} })

    expect(credential).toMatch(/^Payment /)

    const parsed = Credential.deserialize(credential)
    expect(parsed.payload).toMatchObject({ paymentId: 'pay_test_456' })
  })

  test('behavior: includes externalId in credential payload', async () => {
    const charge = whop.charge({
      completeCheckout: async () => 'pay_test_789',
      externalId: 'order_abc',
    })

    const challenge = await createChallenge()
    const credential = await charge.createCredential({ challenge, context: {} })
    const parsed = Credential.deserialize(credential)
    expect(parsed.payload).toMatchObject({
      paymentId: 'pay_test_789',
      externalId: 'order_abc',
    })
  })

  test('behavior: context paymentId skips completeCheckout', async () => {
    const completeCheckout = vi.fn(async () => 'should_not_be_called')

    const charge = whop.charge({ completeCheckout })

    const challenge = await createChallenge()
    const credential = await charge.createCredential({
      challenge,
      context: { paymentId: 'pay_already_paid' },
    })

    expect(completeCheckout).not.toHaveBeenCalled()
    const parsed = Credential.deserialize(credential)
    expect(parsed.payload).toMatchObject({ paymentId: 'pay_already_paid' })
  })

  test('behavior: Mppx.create with whop works through createCredential', async () => {
    const mppx = Mppx.create({
      methods: [
        whop({
          completeCheckout: async () => 'pay_mppx_test',
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

    const credential = await mppx.createCredential(response)
    expect(credential).toMatch(/^Payment /)

    const parsed = Credential.deserialize(credential)
    expect(parsed.payload).toMatchObject({ paymentId: 'pay_mppx_test' })
  })
})
