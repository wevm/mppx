import * as Credential from '../../Credential.js'
import * as MethodIntent from '../../MethodIntent.js'
import * as Intents from '../Intents.js'

const defaultSptUrl = 'https://api.stripe.com/v1/shared_payment/issued_tokens'
const testSptUrl = 'https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens'

/**
 * Creates a Stripe charge method intent for usage on the client.
 *
 * Creates a Shared Payment Token (SPT) and submits it as the
 * credential payload.
 *
 * @example
 * ```ts
 * import { stripe } from 'mpay/client'
 *
 * const charge = stripe.charge({
 *   secretKey: 'sk_test_...',
 *   paymentMethod: 'pm_card_visa',
 * })
 * ```
 */
export function charge(parameters: charge.Parameters) {
  const { paymentMethod, secretKey, testMode } = parameters
  const sptUrl = testMode ? testSptUrl : defaultSptUrl

  return MethodIntent.toClient(Intents.charge, {
    async createCredential({ challenge }) {
      const amount = Number(challenge.request.amount)
      const currency = (challenge.request.currency as string) ?? 'usd'
      const networkId = challenge.request.methodDetails?.networkId as string | undefined

      const expiresAt = Math.floor(Date.now() / 1000) + 3600
      const body = new URLSearchParams({
        payment_method: paymentMethod,
        'usage_limits[currency]': currency,
        'usage_limits[max_amount]': (amount * 100).toString(),
        'usage_limits[expires_at]': expiresAt.toString(),
      })
      if (networkId && !testMode) body.set('seller_details[network_id]', networkId)

      const response = await fetch(sptUrl, {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${secretKey}:`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      })

      if (!response.ok) {
        const error = (await response.json()) as { error: { message: string } }
        throw new Error(`Failed to create SPT: ${error.error.message}`)
      }

      const { id: spt } = (await response.json()) as { id: string }

      return Credential.serialize({
        challenge,
        payload: { spt },
      })
    },
  })
}

export declare namespace charge {
  type Parameters = {
    /** Stripe secret API key. */
    secretKey: string
    /** Stripe payment method ID (e.g. `pm_card_visa` for testing). */
    paymentMethod: string
    /** Use Stripe test helper endpoint for SPT creation. */
    testMode?: boolean | undefined
  }
}
