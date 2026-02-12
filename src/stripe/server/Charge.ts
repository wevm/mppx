import { PaymentExpiredError } from '../../Errors.js'
import type { LooseOmit } from '../../internal/types.js'
import * as MethodIntent from '../../MethodIntent.js'
import * as Intents from '../Intents.js'

/**
 * Creates a Stripe charge method intent for usage on the server.
 *
 * Verifies payment by creating a Stripe PaymentIntent with the provided SPT.
 *
 * @example
 * ```ts
 * import { stripe } from 'mpay/server'
 *
 * const charge = stripe.charge({ secretKey: 'sk_...' })
 * ```
 */
export function charge<const parameters extends charge.Parameters>(parameters: parameters) {
  const { amount, currency, decimals, description, externalId, networkId, secretKey } = parameters

  type Defaults = charge.DeriveDefaults<parameters>
  return MethodIntent.toServer<typeof Intents.charge, Defaults>(Intents.charge, {
    defaults: {
      amount,
      currency,
      decimals,
      description,
      externalId,
      networkId,
    } as unknown as Defaults,

    async verify({ credential }) {
      const { challenge } = credential
      const { request } = challenge

      if (request.expires && new Date(request.expires) < new Date())
        throw new PaymentExpiredError({ expires: request.expires })

      const { spt } = credential.payload as { spt: string }

      const body = new URLSearchParams({
        amount: request.amount as string,
        currency: 'usd',
        shared_payment_granted_token: spt,
        confirm: 'true',
        'automatic_payment_methods[enabled]': 'true',
        'automatic_payment_methods[allow_redirects]': 'never',
      })
      const resolvedNetworkId = request.methodDetails?.networkId as string | undefined
      if (resolvedNetworkId) body.set('metadata[network_id]', resolvedNetworkId)

      const response = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${secretKey}:`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body,
      })

      if (!response.ok) {
        const error = (await response.json()) as { error: { message: string } }
        throw new Error(`Stripe PaymentIntent failed: ${error.error.message}`)
      }

      const pi = (await response.json()) as { id: string; status: string }

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
  type Defaults = LooseOmit<MethodIntent.RequestDefaults<typeof Intents.charge>, 'recipient'>

  type Parameters = {
    /** Stripe secret API key. */
    secretKey: string
  } & Defaults

  type DeriveDefaults<parameters extends Parameters> = Pick<
    parameters,
    Extract<keyof parameters, keyof Defaults>
  > & { decimals: number }
}
