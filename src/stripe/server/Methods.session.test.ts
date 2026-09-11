import { afterEach, describe, expect, test, vi } from 'vp/test'

import { sdkIdentifier } from '../../internal/version.js'
import * as TempoSession from '../../tempo/session/server/Session.js'
import type { SessionSettlementContext } from '../../tempo/session/server/Settlement.js'
import { stripePreviewVersion } from '../internal/constants.js'
import type { StripeClient } from '../internal/types.js'
import { stripe } from './Methods.js'

const recipient = '0x1111111111111111111111111111111111111111' as stripe.DepositAddress<'tempo'>
const context: SessionSettlementContext = {
  txHash: `0x${'ab'.repeat(32)}`,
  channelId: `0x${'cd'.repeat(32)}`,
  trigger: 'scheduled',
  amount: 50_000n,
  delta: 10_000n,
}

function setup(
  options: {
    additional?: boolean
    onSessionSettlement?: TempoSession.session.Parameters['onSessionSettlement']
  } = {},
) {
  const create = vi.fn<StripeClient['paymentIntents']['create']>(async () => ({
    id: 'pi_test',
    status: 'succeeded',
  }))
  const client: StripeClient = {
    paymentIntents: { create },
    rawRequest: vi.fn(),
  }
  const payments = stripe({
    client,
    networkId: 'test-profile',
    livemode: true,
    metadata: { integration: 'sessions' },
    connect: { stripeAccount: 'acct_test', applicationFeeAmount: 1 },
    depositAddresses: { tempo: recipient },
  })
  // Capture the hook passed to the real Tempo method; only Stripe I/O is mocked.
  const session = vi.spyOn(TempoSession, 'session')
  const parameters = {
    settlementSchedule: { amount: '0.01' },
    onSessionSettlement: options.onSessionSettlement,
  }
  if (options.additional) payments.defaultMethods().additional({ tempo: { session: parameters } })
  else payments.tempo.session({ recipient, ...parameters })
  const settle = session.mock.calls.at(-1)![0]!.onSessionSettlement!
  return { create, settle }
}

afterEach(() => vi.restoreAllMocks())

describe('Stripe session settlement recording', () => {
  test.each(['scheduled', 'settle', 'close'] as const)(
    'records the delta for a %s transaction through the shared Stripe recorder',
    async (trigger) => {
      const { create, settle } = setup()
      await settle({ ...context, trigger })

      expect(create).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          amount: 1,
          currency: 'usd',
          confirm: true,
          payment_method_data: { type: 'crypto' },
          payment_method_types: ['crypto'],
          payment_method_options: {
            crypto: {
              mode: 'transaction_verification',
              transaction_verification_options: {
                network: 'tempo',
                transaction_hash: context.txHash,
              },
            },
          },
          application_fee_amount: 1,
          metadata: expect.objectContaining({
            mpp_sdk: sdkIdentifier,
            integration: 'sessions',
          }),
        }),
        {
          apiVersion: stripePreviewVersion,
          idempotencyKey: context.txHash,
          stripeAccount: 'acct_test',
        },
      )
    },
  )

  test('also records sessions added to defaultMethods()', async () => {
    const { create, settle } = setup({ additional: true })
    await settle(context)
    expect(create).toHaveBeenCalledTimes(1)
  })

  test.each([0n, 1n, 5_000n, 9_999n])(
    'skips a %s raw-unit delta but calls the merchant hook',
    async (delta) => {
      const onSessionSettlement = vi.fn()
      const { create, settle } = setup({ onSessionSettlement })
      const event = { ...context, trigger: 'close' as const, delta }
      await settle(event)
      expect(create).not.toHaveBeenCalled()
      expect(onSessionSettlement).toHaveBeenCalledExactlyOnceWith(event)
    },
  )

  test('floors each transaction independently without carrying fractional cents', async () => {
    const { create, settle } = setup()
    await settle({ ...context, delta: 19_999n })
    await settle({ ...context, txHash: `0x${'ef'.repeat(32)}`, amount: 69_998n, delta: 19_999n })
    expect(create.mock.calls.map(([params]) => (params as any).amount)).toEqual([1, 1])
  })

  test('uses the same idempotency key when a settlement is delivered again', async () => {
    const { create, settle } = setup()
    await settle(context)
    await settle(context)
    expect(create.mock.calls[0]).toEqual(create.mock.calls[1])
  })

  test('records before calling the merchant hook', async () => {
    const onSessionSettlement = vi.fn(() => {
      expect(create).toHaveBeenCalledTimes(1)
    })
    const { create, settle } = setup({ onSessionSettlement })
    await settle(context)
    expect(onSessionSettlement).toHaveBeenCalledExactlyOnceWith(context)
  })

  test('a merchant hook failure does not prevent recording', async () => {
    const error = new Error('merchant hook failed')
    const { create, settle } = setup({
      onSessionSettlement: () => {
        throw error
      },
    })
    await expect(settle(context)).rejects.toThrow(error)
    expect(create).toHaveBeenCalledTimes(1)
  })

  test('logs Stripe failures without failing settlement or skipping the merchant hook', async () => {
    const onSessionSettlement = vi.fn()
    const { create, settle } = setup({ onSessionSettlement })
    const error = new Error('Stripe unavailable')
    create.mockRejectedValueOnce(error)
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    await expect(settle(context)).resolves.toBeUndefined()
    expect(log).toHaveBeenCalledWith('[stripe] failed to record crypto payment:', error)
    expect(onSessionSettlement).toHaveBeenCalledExactlyOnceWith(context)
  })

  test('inherits the shared recorder fallback when Stripe rejects optional metadata', async () => {
    const { create, settle } = setup()
    create.mockRejectedValueOnce({ type: 'StripeInvalidRequestError' })
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    await settle(context)
    expect(create).toHaveBeenCalledTimes(2)
    expect(create).toHaveBeenLastCalledWith(
      expect.objectContaining({
        amount: 1,
        metadata: { machine_payment: 'true', mpp_sdk: sdkIdentifier },
      }),
      expect.objectContaining({ idempotencyKey: `${context.txHash}_fallback` }),
    )
  })
})
