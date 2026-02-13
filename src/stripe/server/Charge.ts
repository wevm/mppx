import {
  PaymentActionRequiredError,
  PaymentExpiredError,
  VerificationFailedError,
} from '../../Errors.js'
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
  const {
    amount,
    currency,
    decimals,
    description,
    externalId,
    metadata,
    networkId,
    secretKey,
  } = parameters

  type Defaults = charge.DeriveDefaults<parameters>
  return MethodIntent.toServer<typeof Intents.charge, Defaults>(Intents.charge, {
    defaults: {
      amount,
      currency,
      decimals,
      description,
      externalId,
      metadata,
      networkId,
    } as unknown as Defaults,

    async verify({ credential }) {
      const { challenge } = credential
      const { request } = challenge

      if (request.expires && new Date(request.expires) < new Date())
        throw new PaymentExpiredError({ expires: request.expires })

      const parsed = Intents.charge.schema.credential.payload.safeParse(credential.payload)
      if (!parsed.success) throw new Error('Invalid credential payload: missing or malformed spt')
      const { spt, externalId: credentialExternalId } = parsed.data as {
        spt: string
        externalId?: string
      }

      const body = new URLSearchParams({
        amount: request.amount as string,
        currency: request.currency as string,
        shared_payment_granted_token: spt,
        confirm: 'true',
        'automatic_payment_methods[enabled]': 'true',
        'automatic_payment_methods[allow_redirects]': 'never',
      })
      const resolvedMetadata = request.methodDetails?.metadata as Record<string, string> | undefined
      if (resolvedMetadata) {
        for (const [key, value] of Object.entries(resolvedMetadata)) {
          body.set(`metadata[${key}]`, value)
        }
      }

      const response = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${secretKey}:`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': `mpay_${challenge.id}_${spt}`,
        },
        body,
      })

      if (!response.ok) {
        const error = (await response.json()) as { error: { message: string } }
        throw new VerificationFailedError({ reason: 'Stripe PaymentIntent failed' })
      }

      const pi = (await response.json()) as { id: string; status: string }

      if (pi.status === 'requires_action') {
        throw new PaymentActionRequiredError({ reason: 'Stripe PaymentIntent requires action' })
      }
      if (pi.status !== 'succeeded') throw new Error(`Stripe PaymentIntent status: ${pi.status}`)

      return {
        method: 'stripe',
        status: 'success',
        timestamp: new Date().toISOString(),
        reference: pi.id,
        ...(credentialExternalId ? { externalId: credentialExternalId } : {}),
      } as const
    },
  })
}

export declare namespace charge {
  type Defaults = LooseOmit<MethodIntent.RequestDefaults<typeof Intents.charge>, 'recipient'>

  type Parameters = {
    /** Stripe secret API key. */
    secretKey: string
    /** Optional metadata to include in SPT creation requests. */
    metadata?: Record<string, string> | undefined
  } & Defaults

  type DeriveDefaults<parameters extends Parameters> = Pick<
    parameters,
    Extract<keyof parameters, keyof Defaults>
  > & { decimals: number }
}
