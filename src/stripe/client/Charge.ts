import * as Credential from '../../Credential.js'
import { VerificationFailedError } from '../../Errors.js'
import * as MethodIntent from '../../MethodIntent.js'
import * as Intents from '../Intents.js'

const stripeApiBase = 'https://api.stripe.com'
const stripeVersion = '2025-06-30.basil'

type IssuedToken = {
  id: string
  object: string
  granted_token: {
    id: string
  }
}

type StripeError = {
  error: {
    type: string
    code?: string
    message: string
  }
}

function createStripeClient(apiKey: string) {
  async function stripeRequest<T>(
    method: string,
    path: string,
    body: Record<string, unknown>,
  ): Promise<T> {
    const response = await fetch(`${stripeApiBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Stripe-Version': stripeVersion,
      },
      body: encodeBody(body),
    })

    if (!response.ok) {
      let errorData: StripeError | undefined
      try {
        errorData = (await response.json()) as StripeError
      } catch {}

      const message = errorData?.error?.message ?? `Stripe API error (${response.status})`
      throw new VerificationFailedError({ reason: message })
    }

    return (await response.json()) as T
  }

  const isTestMode = apiKey.startsWith('sk_test_')

  return {
    async createSpt(params: {
      currency: string
      max_amount: number
      expires_at: number
      network_id: string
      payment_method: string
    }): Promise<string> {
      const path = isTestMode
        ? '/v1/test_helpers/shared_payment/granted_tokens'
        : '/v1/shared_payment/issued_tokens'

      const body: Record<string, unknown> = {
        payment_method: params.payment_method,
        usage_limits: {
          currency: params.currency,
          max_amount: params.max_amount,
          expires_at: params.expires_at,
        },
        seller_details: {
          network_id: params.network_id,
        },
      }

      const result = await stripeRequest<IssuedToken>('POST', path, body)

      return isTestMode ? result.granted_token.id : result.id
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
 * Creates a Stripe charge method intent for usage on the client.
 *
 * @example
 * ```ts
 * import { stripe } from 'mpay/stripe/client'
 *
 * const charge = stripe.charge({
 *   apiKey: 'sk_test_...',
 *   paymentMethod: 'pm_card_visa',
 * })
 * ```
 */
export function charge(parameters: charge.Parameters) {
  const { apiKey, paymentMethod } = parameters

  return MethodIntent.toClient(Intents.charge, {
    async createCredential({ challenge }) {
      const { request } = challenge
      const { amount, currency, expires, methodDetails } = request

      const networkId = methodDetails?.network_id
      if (!networkId)
        throw new VerificationFailedError({
          reason: 'Missing network_id in methodDetails',
        })

      const expiresAt = expires
        ? Math.floor(new Date(expires).getTime() / 1000)
        : Math.floor(Date.now() / 1000) + 300

      const stripe = createStripeClient(apiKey)

      const spt = await stripe.createSpt({
        currency: (currency as string).toLowerCase(),
        max_amount: Number(amount),
        expires_at: expiresAt,
        network_id: networkId as string,
        payment_method: paymentMethod,
      })

      return Credential.serialize({
        challenge,
        payload: { spt, type: 'spt' as const },
      })
    },
  })
}

export declare namespace charge {
  type Parameters = {
    /** Stripe secret API key (`sk_test_...` or `sk_live_...`). */
    apiKey: string
    /** Stripe PaymentMethod ID (e.g., `pm_card_visa`). */
    paymentMethod: string
  }
}
