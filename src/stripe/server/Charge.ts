import { PaymentExpiredError, VerificationFailedError } from '../../Errors.js'
import type { ExactPartial } from '../../internal/types.js'
import * as MethodIntent from '../../MethodIntent.js'
import * as Intents from '../Intents.js'

const stripeApiBase = 'https://api.stripe.com'
const stripeVersion = '2025-06-30.basil'

type GrantedToken = {
  id: string
  object: string
  deactivated_at: number | null
  deactivated_reason: string | null
  usage_limits: {
    currency: string
    expires_at: number
    max_amount: number
  } | null
}

type PaymentIntent = {
  id: string
  status: string
  last_payment_error: {
    type: string
    code: string
    decline_code?: string
    message: string
  } | null
}

type StripeError = {
  error: {
    type: string
    code?: string
    decline_code?: string
    message: string
    param?: string
  }
}

function createStripeClient(apiKey: string) {
  async function stripeRequest<T>(
    method: string,
    path: string,
    options?: { body?: Record<string, unknown>; idempotencyKey?: string },
  ): Promise<T> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${apiKey}`,
      'Stripe-Version': stripeVersion,
    }

    if (options?.idempotencyKey) headers['Idempotency-Key'] = options.idempotencyKey

    const init: RequestInit = { method, headers }
    if (options?.body) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      init.body = encodeBody(options.body)
    }

    const response = await fetch(`${stripeApiBase}${path}`, init)

    if (!response.ok) {
      const status = response.status
      let errorData: StripeError | undefined
      try {
        errorData = (await response.json()) as StripeError
      } catch {}

      if (status === 401)
        throw new VerificationFailedError({
          reason: 'Stripe authentication failed — check API key',
        })

      if (status === 429)
        throw new VerificationFailedError({
          reason: 'Stripe rate limit exceeded',
        })

      if (status >= 500)
        throw new VerificationFailedError({
          reason: `Stripe server error (${status})`,
        })

      if (errorData?.error) {
        const { type, message, decline_code } = errorData.error
        if (type === 'card_error') {
          const reason = decline_code
            ? `Card declined (${decline_code}): ${message}`
            : `Card error: ${message}`
          throw new VerificationFailedError({ reason })
        }
        if (type === 'invalid_request_error')
          throw new VerificationFailedError({
            reason: `Invalid request: ${message}`,
          })
      }

      throw new VerificationFailedError({
        reason: `Stripe API error (${status})`,
      })
    }

    return (await response.json()) as T
  }

  return {
    async getGrantedToken(spt: string): Promise<GrantedToken> {
      return stripeRequest<GrantedToken>(
        'GET',
        `/v1/shared_payment/granted_tokens/${encodeURIComponent(spt)}`,
      )
    },

    async createPaymentIntent(params: {
      amount: number
      currency: string
      shared_payment_granted_token: string
      confirm: boolean
      idempotencyKey: string
      description?: string
      metadata?: Record<string, string>
    }): Promise<PaymentIntent> {
      const body: Record<string, unknown> = {
        amount: params.amount,
        currency: params.currency,
        shared_payment_granted_token: params.shared_payment_granted_token,
        confirm: params.confirm,
      }
      if (params.description) body.description = params.description
      if (params.metadata) body.metadata = params.metadata

      return stripeRequest<PaymentIntent>('POST', '/v1/payment_intents', {
        body,
        idempotencyKey: params.idempotencyKey,
      })
    },
  }
}

function encodeBody(obj: Record<string, unknown>, prefix?: string): string {
  const parts: string[] = []
  for (const [key, value] of Object.entries(obj)) {
    const fullKey = prefix ? `${prefix}[${key}]` : key
    if (value != null && typeof value === 'object' && !Array.isArray(value)) {
      parts.push(encodeBody(value as Record<string, unknown>, fullKey))
    } else if (value != null) {
      parts.push(`${encodeURIComponent(fullKey)}=${encodeURIComponent(String(value))}`)
    }
  }
  return parts.filter(Boolean).join('&')
}

/**
 * Creates a Stripe charge method intent for usage on the server.
 *
 * @example
 * ```ts
 * import { stripe } from 'mpay/stripe/server'
 *
 * const handler = stripe({ apiKey: 'sk_live_...' })
 * ```
 */
export function charge<const parameters extends charge.Parameters>(parameters: parameters) {
  const { apiKey, amount, currency, decimals = 2, description } = parameters

  type Defaults = charge.DeriveDefaults<parameters>
  return MethodIntent.toServer<typeof Intents.charge, Defaults>(Intents.charge, {
    defaults: {
      amount,
      currency,
      decimals,
      description,
    } as unknown as Defaults,

    async verify({ credential, request }) {
      const { challenge } = credential
      const { amount, expires } = challenge.request
      const challengeCurrency = challenge.request.currency as string
      const { spt } = credential.payload

      if (expires && new Date(expires) < new Date()) throw new PaymentExpiredError({ expires })

      const stripe = createStripeClient(apiKey)

      const grantedToken = await stripe.getGrantedToken(spt)

      if (grantedToken.deactivated_at)
        throw new VerificationFailedError({
          reason: `SPT ${spt} was deactivated`,
        })

      if (grantedToken.usage_limits) {
        const limits = grantedToken.usage_limits

        if (limits.expires_at && limits.expires_at * 1000 < Date.now())
          throw new PaymentExpiredError({
            expires: new Date(limits.expires_at * 1000).toISOString(),
          })

        if (limits.currency && limits.currency.toLowerCase() !== challengeCurrency.toLowerCase())
          throw new VerificationFailedError({
            reason: `SPT currency mismatch: expected ${challengeCurrency}, got ${limits.currency}`,
          })

        if (limits.max_amount && Number(amount) > limits.max_amount)
          throw new VerificationFailedError({
            reason: `Amount ${amount} exceeds SPT max_amount ${limits.max_amount}`,
          })
      }

      const resolvedCurrency = request.currency ?? challengeCurrency

      const pi = await stripe.createPaymentIntent({
        amount: Number(amount),
        currency: resolvedCurrency.toLowerCase(),
        shared_payment_granted_token: spt,
        confirm: true,
        idempotencyKey: `mpay_${challenge.id}_${spt}`,
        ...(description && { description }),
        ...(request.metadata && { metadata: request.metadata }),
      })

      if (pi.status === 'requires_action')
        throw new VerificationFailedError({
          reason:
            'Payment requires additional authentication (3DS/SCA) which is not supported in headless flows',
        })

      if (pi.status === 'requires_payment_method')
        throw new VerificationFailedError({
          reason: pi.last_payment_error?.message ?? 'Card was declined',
        })

      if (pi.status !== 'succeeded' && pi.status !== 'processing')
        throw new VerificationFailedError({
          reason: `Unexpected PaymentIntent status: ${pi.status}`,
        })

      return {
        method: 'stripe',
        status: 'success',
        timestamp: new Date().toISOString(),
        reference: pi.id,
      } as const
    },
  })
}

export declare namespace charge {
  type Defaults = ExactPartial<MethodIntent.RequestDefaults<typeof Intents.charge>>

  type Parameters = {
    /** Stripe secret API key (`sk_live_...` or `sk_test_...`). */
    apiKey: string
    /** Default description for PaymentIntents. */
    description?: string | undefined
  } & Defaults

  type DeriveDefaults<parameters extends Parameters> = Pick<
    parameters,
    Extract<keyof parameters, keyof Defaults>
  > & { decimals: number }
}
