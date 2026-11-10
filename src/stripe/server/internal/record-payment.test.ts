import { describe, expect, test, vi } from 'vp/test'

import { sdkIdentifier } from '../../../internal/version.js'
import type { StripeClient } from '../../internal/types.js'
import { recordCryptoPayment, recordPayment } from './record-payment.js'

function createClient(create: (...args: any[]) => Promise<any>): StripeClient {
  return { paymentIntents: { create } }
}

describe('recordCryptoPayment', () => {
  test.each([
    ['14999', 1],
    ['15000', 1],
    ['19999', 1],
    ['20000', 2],
  ])('records %s raw units as %i cents', async (amount, amountCents) => {
    const create = vi.fn().mockResolvedValue({ id: 'pi_123', status: 'processing' })

    await recordCryptoPayment(createClient(create), {
      amount,
      network: 'tempo',
      analyticsMetadata: {},
      reference: '0xtx123',
    })

    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ amount: amountCents }),
      expect.anything(),
    )
  })

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

describe('recordPayment', () => {
  const parameters = { amount: '500000', network: 'tempo', reference: '0xtx123' } as const

  test('creates a PaymentIntent keyed by the transaction hash', async () => {
    const create = vi.fn().mockResolvedValue({ id: 'pi_123', status: 'succeeded' })

    await expect(
      recordPayment(createClient(create), { ...parameters, metadata: { order: 'o_1' } }),
    ).resolves.toEqual({
      paymentIntentId: 'pi_123',
      paymentIntentStatus: 'succeeded',
      status: 'created',
    })
    expect(create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        amount: 50,
        metadata: { order: 'o_1' },
        payment_method_options: {
          crypto: {
            mode: 'transaction_verification',
            transaction_verification_options: { network: 'tempo', transaction_hash: '0xtx123' },
          },
        },
      }),
      expect.objectContaining({ idempotencyKey: '0xtx123' }),
    )
  })

  test('reports a replayed PaymentIntent', async () => {
    const create = vi.fn().mockResolvedValue({
      id: 'pi_123',
      status: 'succeeded',
      lastResponse: { headers: { 'idempotent-replayed': 'true' } },
    })
    await expect(recordPayment(createClient(create), parameters)).resolves.toEqual({
      paymentIntentId: 'pi_123',
      paymentIntentStatus: 'succeeded',
      status: 'replayed',
    })
  })

  test('reports a reused key with different parameters as a conflict', async () => {
    const create = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error('Keys reused'), { type: 'StripeIdempotencyError' }),
      )
    await expect(recordPayment(createClient(create), parameters)).resolves.toEqual({
      status: 'key_conflict',
    })
  })

  test('skips amounts below one cent', async () => {
    const create = vi.fn()
    await expect(
      recordPayment(createClient(create), { ...parameters, amount: '9999' }),
    ).resolves.toEqual({ status: 'below_minimum' })
    expect(create).not.toHaveBeenCalled()
  })

  test('throws other Stripe failures', async () => {
    const create = vi.fn().mockRejectedValue(new Error('Connection reset'))
    await expect(recordPayment(createClient(create), parameters)).rejects.toThrow(
      'Connection reset',
    )
  })
})

test('recordPayment reports a PaymentIntent that is still processing', async () => {
  const create = vi.fn().mockResolvedValue({ id: 'pi_123', status: 'processing' })
  await expect(
    recordPayment(createClient(create), { amount: '500000', network: 'tempo', reference: '0xtx' }),
  ).resolves.toMatchObject({ paymentIntentStatus: 'processing', status: 'created' })
})
