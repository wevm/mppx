import { describe, expect, test, vi } from 'vp/test'

import { sdkIdentifier } from '../../../internal/version.js'
import type { StripeClient } from '../../internal/types.js'
import { recordCryptoPayment } from './record-payment.js'

function createClient(create: (...args: any[]) => Promise<any>): StripeClient {
  return { paymentIntents: { create } }
}

describe('recordCryptoPayment', () => {
  test('retries without optional fields after a definitive invalid request', async () => {
    const invalidRequest = Object.assign(new Error('Invalid customer'), {
      type: 'StripeInvalidRequestError',
    })
    const create = vi
      .fn()
      .mockRejectedValueOnce(invalidRequest)
      .mockResolvedValueOnce({ id: 'pi_123', status: 'succeeded' })
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await recordCryptoPayment(createClient(create), {
      amount: '500000',
      network: 'tempo',
      analyticsMetadata: {
        machine_payment: 'true',
        mpp_challenge_id: 'challenge_123',
        mpp_intent: 'charge',
        mpp_sdk: sdkIdentifier,
      },
      paymentIntentOptions: {
        amount: 999,
        confirm: false,
        customer: 'cus_123',
        currency: 'eur',
        hooks: { inputs: { tax: { calculation: 'taxcalc_123' } } },
        metadata: { machine_payment: 'custom', request_id: 'req_123' },
        receipt_email: 'customer@example.com',
      } as any,
      reference: '0xtx123',
    })

    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[0]?.[0]).toEqual(
      expect.objectContaining({
        amount: 50,
        confirm: true,
        customer: 'cus_123',
        currency: 'usd',
        hooks: { inputs: { tax: { calculation: 'taxcalc_123' } } },
        metadata: {
          machine_payment: 'custom',
          mpp_challenge_id: 'challenge_123',
          mpp_intent: 'charge',
          mpp_sdk: sdkIdentifier,
          request_id: 'req_123',
        },
        receipt_email: 'customer@example.com',
      }),
    )
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('customer')
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('hooks')
    expect(create.mock.calls[1]?.[0]).not.toHaveProperty('receipt_email')
    expect(create.mock.calls[1]?.[0]).toEqual(
      expect.objectContaining({
        metadata: {
          machine_payment: 'true',
          mpp_challenge_id: 'challenge_123',
          mpp_intent: 'charge',
          mpp_sdk: sdkIdentifier,
        },
      }),
    )
    expect(create.mock.calls[0]?.[1]).toEqual(
      expect.objectContaining({ idempotencyKey: '0xtx123' }),
    )
    expect(create.mock.calls[1]?.[1]).toEqual(
      expect.objectContaining({ idempotencyKey: '0xtx123_fallback' }),
    )
    expect(warning).toHaveBeenCalledWith(
      expect.stringContaining('retrying without them'),
      invalidRequest,
    )
  })

  test('does not retry after an ambiguous failure', async () => {
    const create = vi.fn().mockRejectedValue(new Error('Connection reset'))
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})

    await recordCryptoPayment(createClient(create), {
      amount: '500000',
      network: 'tempo',
      analyticsMetadata: { machine_payment: 'true', mpp_sdk: sdkIdentifier },
      paymentIntentOptions: { customer: 'cus_123' },
      reference: '0xtx123',
    })

    expect(create).toHaveBeenCalledOnce()
    expect(error).toHaveBeenCalledWith(
      '[stripe] failed to record crypto payment:',
      expect.any(Error),
    )
  })
})
