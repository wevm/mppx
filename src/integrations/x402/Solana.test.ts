import type { x402ResourceServer } from '@x402/core/server'
import type { PaymentRequired, PaymentRequirements } from '@x402/core/types'
import { Challenge, Credential } from 'mppx'
import { describe, expect, test, vi } from 'vp/test'

import { createHandler, selectRequirement } from './Solana.js'

const requirement = {
  amount: '10000',
  asset: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
  extra: { feePayer: 'CKPKJWNdJEqa81x7CkZ14BVPiY6y16Sxs7owznqtWYp5' },
  maxTimeoutSeconds: 60,
  network: 'solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1',
  payTo: '6G4RJQy7aNfS2CA2vifBhJSQtrRjhPooTWSqBqQzc7xT',
  scheme: 'exact',
} satisfies PaymentRequirements

function paymentRequired(accepts: PaymentRequirements[]): PaymentRequired {
  return { accepts, resource: { url: 'https://example.com/data' }, x402Version: 2 }
}

function server(overrides: Record<string, unknown> = {}) {
  return {
    getAssetDecimalsForRequirements: () => 6,
    settlePayment: vi.fn(async () => ({
      network: requirement.network,
      success: true,
      transaction: 'sig',
    })),
    verifyPayment: vi.fn(async () => ({ isValid: true, payer: 'payer' })),
    ...overrides,
  } as unknown as x402ResourceServer & {
    settlePayment: ReturnType<typeof vi.fn>
    verifyPayment: ReturnType<typeof vi.fn>
  }
}

const config = (x402: x402ResourceServer) => ({
  secretKey: 'solana-unit-secret-key-solana-unit-secret',
  server: x402,
})
const context = {} as never

describe('selectRequirement', () => {
  test.each([
    ['non-exact scheme', { scheme: 'upto' }],
    ['unknown cluster', { network: 'solana:4uhcVJyU9pJkvQyS88uRDiswHXSCkY3z' }],
    ['EVM network', { network: 'eip155:8453' }],
    ['missing fee payer', { extra: {} }],
    ['seller memo', { extra: { ...requirement.extra, memo: 'order-1' } }],
    ['malformed asset', { asset: '0x1234' }],
    ['malformed recipient', { payTo: 'not-base58!' }],
    ['non-integer amount', { amount: '0.01' }],
  ])('rejects %s', (_name, override) => {
    const candidate = { ...requirement, ...override } as PaymentRequirements
    expect(selectRequirement(paymentRequired([candidate]))).toBeUndefined()
  })

  test('accepts a fee-sponsored Solana exact requirement', () => {
    expect(selectRequirement(paymentRequired([requirement]))).toEqual(requirement)
  })

  test('leaves routes with x402 extensions to x402', () => {
    const required = { ...paymentRequired([requirement]), extensions: { bazaar: {} } }
    expect(selectRequirement(required)).toBeUndefined()
  })
})

describe('createHandler', () => {
  function handlerFor(x402: x402ResourceServer) {
    return createHandler({
      config: config(x402),
      context,
      paymentRequired: paymentRequired([requirement]),
    })!
  }

  test('offers a solana/charge challenge built from the requirement', async () => {
    const { payment } = await handlerFor(server())(new Request('https://example.com/data'))
    if (payment.status !== 402) throw new Error('expected 402')
    const challenge = Challenge.fromResponse(payment.challenge)
    expect(challenge.method).toBe('solana')
    expect(challenge.intent).toBe('charge')
    expect(challenge.request).toEqual({
      amount: '10000',
      currency: requirement.asset,
      methodDetails: {
        decimals: 6,
        feePayer: true,
        feePayerKey: requirement.extra.feePayer,
        network: 'devnet',
      },
      recipient: requirement.payTo,
    })
  })

  async function pay(x402: ReturnType<typeof server>) {
    const handler = handlerFor(x402)
    const { payment } = await handler(new Request('https://example.com/data'))
    if (payment.status !== 402) throw new Error('expected 402')
    const challenge = Challenge.fromResponse(payment.challenge)
    const authorization = Credential.serialize(
      Credential.from({ challenge, payload: { transaction: 'AQ==', type: 'transaction' } }),
    )
    const request = new Request('https://example.com/data', {
      headers: { Authorization: authorization },
    })
    return (await handler(request)).payment
  }

  test('verifies and settles the transaction through the x402 facilitator', async () => {
    const x402 = server()
    const payment = await pay(x402)
    expect(payment.status).toBe(200)
    expect(x402.verifyPayment.mock.calls[0]!.slice(0, 2)).toEqual([
      {
        accepted: requirement,
        payload: { transaction: 'AQ==' },
        resource: { url: 'https://example.com/data' },
        x402Version: 2,
      },
      requirement,
    ])
    expect(x402.settlePayment).toHaveBeenCalledOnce()
  })

  test('does not settle when the facilitator rejects the transaction', async () => {
    const x402 = server({
      verifyPayment: vi.fn(async () => ({
        invalidReason: 'invalid_exact_svm_payload',
        isValid: false,
      })),
    })
    const payment = await pay(x402)
    expect(payment.status).toBe(402)
    expect(x402.settlePayment).not.toHaveBeenCalled()
  })
})
