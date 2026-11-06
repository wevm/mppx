import type * as PaymentIntent from '../../internal/payment-intent.js'
import type { StripeClient } from '../../internal/types.js'
import type { stripe } from '../Methods.js'
import { createPaymentIntent, type ConnectConfig } from './request.js'

const NETWORK_CONFIG: Record<stripe.Network, { stripeNetworkName: string; tokenDecimals: number }> =
  {
    tempo: { stripeNetworkName: 'tempo', tokenDecimals: 6 },
    base: { stripeNetworkName: 'base', tokenDecimals: 6 },
    solana: { stripeNetworkName: 'solana', tokenDecimals: 6 },
  }

/**
 * Records a crypto payment as a Stripe PaymentIntent using transaction_verification mode.
 * If Stripe rejects caller-provided optional fields, retries once without them.
 * Errors are logged but never thrown (the returned Promise always resolves).
 */
export function recordCryptoPayment(
  client: StripeClient,
  parameters: {
    network: stripe.Network
    reference: string
    amount: string
    connect?: ConnectConfig
    analyticsMetadata: Record<string, string>
    paymentIntentOptions?: PaymentIntent.Options | undefined
  },
): Promise<void> {
  const { network, reference, amount, connect, analyticsMetadata, paymentIntentOptions } =
    parameters
  const { customer, hooks, metadata, receipt_email } = paymentIntentOptions ?? {}
  const amountCents = toAmountCents(network, amount)
  if (amountCents < 1) {
    console.warn(
      `[stripe] skipping PI recording: ${amount} raw units on ${network} floors to ${amountCents} cents (below Stripe minimum)`,
    )
    return Promise.resolve()
  }

  const requiredParams = paymentIntentParams({
    amountCents,
    metadata: analyticsMetadata,
    network,
    reference,
  })
  const options = {
    idempotencyKey: reference,
    ...(connect && { connect }),
  }
  const hasOptionalParams = paymentIntentOptions !== undefined
  return createPaymentIntent(
    client,
    {
      ...requiredParams,
      ...(customer !== undefined && { customer }),
      ...(hooks !== undefined && { hooks }),
      metadata: { ...analyticsMetadata, ...metadata },
      ...(receipt_email !== undefined && { receipt_email }),
    },
    options,
  )
    .catch((error: unknown) => {
      if (!hasOptionalParams || !isDefinitiveInvalidRequestError(error)) throw error
      console.warn(
        '[stripe] optional PI recording fields were rejected; retrying without them:',
        error,
      )
      return createPaymentIntent(client, requiredParams, {
        ...options,
        idempotencyKey: `${reference}_fallback`,
      })
    })
    .then(
      () => {},
      (err) => {
        console.error('[stripe] failed to record crypto payment:', err)
      },
    )
}

/**
 * Records a settled crypto payment as a Stripe PaymentIntent in `transaction_verification` mode,
 * the same call mppx makes after a Stripe-backed payment settles. Use it to record payments mppx
 * could not, such as when the process stopped between the broadcast and the recording.
 *
 * The transaction hash (`reference`) is the Stripe idempotency key, as it is for mppx's own
 * recording, so a repeat call for the same reference does not create a second PaymentIntent while
 * Stripe keeps the key (at least 24 hours): it returns `replayed`, or `key_conflict` when an
 * earlier call sent different parameters (such as mppx's own metadata). Stripe also caches failed
 * responses under the key, so `key_conflict` does not mean a PaymentIntent exists: confirm it in
 * Stripe before treating the payment as recorded. mppx's own recording uses
 * `<reference>_fallback` instead only when Stripe rejected the server's `paymentIntentOptions`.
 *
 * Unlike mppx's own recording, it throws when Stripe fails, so the caller can retry.
 */
export async function recordPayment(
  client: StripeClient,
  parameters: recordPayment.Parameters,
): Promise<recordPayment.ReturnType> {
  const { amount, connect, metadata = {}, network, reference } = parameters
  const amountCents = toAmountCents(network, amount)
  if (amountCents < 1) return { status: 'below_minimum' }
  try {
    const result = await createPaymentIntent(
      client,
      paymentIntentParams({ amountCents, metadata, network, reference }),
      { idempotencyKey: reference, ...(connect && { connect }) },
    )
    return {
      paymentIntentId: result.id,
      paymentIntentStatus: result.status,
      status: result.replayed ? 'replayed' : 'created',
    }
  } catch (error) {
    if (isIdempotencyError(error)) return { status: 'key_conflict' }
    throw error
  }
}

export declare namespace recordPayment {
  type Parameters = {
    /** Amount in the token's raw units (6 decimals), as in the Challenge request. */
    amount: string
    /** Stripe Connect settings, when the payment belongs to a connected account. */
    connect?: ConnectConfig | undefined
    /** PaymentIntent metadata. */
    metadata?: Record<string, string> | undefined
    /** Network the payment settled on. */
    network: stripe.Network
    /** Transaction hash of the settled payment. */
    reference: string
  }

  type ReturnType =
    | {
        /** A PaymentIntent was created, or Stripe replayed the earlier one for this reference. */
        status: 'created' | 'replayed'
        paymentIntentId: string
        /**
         * The PaymentIntent's Stripe status. Only `succeeded` means Stripe verified the
         * transaction; others, such as `processing` or `requires_action`, need a later lookup.
         */
        paymentIntentStatus: string
      }
    | {
        /**
         * An earlier call used this reference with different parameters. Stripe caches failed
         * responses too, so whether that call created a PaymentIntent is unknown.
         */
        status: 'key_conflict'
      }
    | {
        /** The amount is below Stripe's 1 cent minimum, so nothing was recorded. */
        status: 'below_minimum'
      }
}

/** Converts raw token units to whole US cents, rounding down. */
function toAmountCents(network: stripe.Network, amount: string): number {
  const { tokenDecimals } = NETWORK_CONFIG[network]
  return Number(BigInt(amount) / 10n ** BigInt(tokenDecimals - 2))
}

/** The PaymentIntent parameters every recording sends. */
function paymentIntentParams(parameters: {
  amountCents: number
  metadata: Record<string, string>
  network: stripe.Network
  reference: string
}) {
  const { amountCents, metadata, network, reference } = parameters
  return {
    amount: amountCents,
    currency: 'usd',
    confirm: true,
    payment_method_data: { type: 'crypto' },
    payment_method_types: ['crypto'],
    payment_method_options: {
      crypto: {
        mode: 'transaction_verification',
        transaction_verification_options: {
          network: NETWORK_CONFIG[network].stripeNetworkName,
          transaction_hash: reference,
        },
      },
    },
    metadata,
  }
}

/** Returns whether Stripe rejected a reused idempotency key sent with different parameters. */
function isIdempotencyError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as {
    raw?: { type?: unknown } | undefined
    rawType?: unknown
    type?: unknown
  }
  return (
    candidate.type === 'StripeIdempotencyError' ||
    candidate.rawType === 'idempotency_error' ||
    candidate.raw?.type === 'idempotency_error'
  )
}

/** Returns whether Stripe definitively rejected request parameters before creating a PI. */
function isDefinitiveInvalidRequestError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const candidate = error as {
    raw?: { type?: unknown } | undefined
    rawType?: unknown
    type?: unknown
  }
  return (
    candidate.type === 'StripeInvalidRequestError' ||
    candidate.rawType === 'invalid_request_error' ||
    candidate.raw?.type === 'invalid_request_error'
  )
}
