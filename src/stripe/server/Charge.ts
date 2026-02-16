import type * as Credential from '../../Credential.js'
import {
  PaymentActionRequiredError,
  PaymentExpiredError,
  VerificationFailedError,
} from '../../Errors.js'
import type { LooseOmit } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as Methods from '../Methods.js'

/**
 * Creates a Stripe charge method intent for usage on the server.
 *
 * Verifies payment by creating a Stripe PaymentIntent with the provided SPT.
 *
 * @example
 * ```ts
 * import { stripe } from 'mppx/server'
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
    paymentMethodTypes,
    secretKey,
  } = parameters

  type Defaults = charge.DeriveDefaults<parameters>
  return Method.toServer<typeof Methods.charge, Defaults>(Methods.charge, {
    defaults: {
      amount,
      currency,
      decimals,
      description,
      externalId,
      metadata,
      networkId,
      paymentMethodTypes,
    } as unknown as Defaults,

    async verify({ credential }) {
      const { challenge } = credential
      const { request } = challenge

      if (request.expires && new Date(request.expires) < new Date())
        throw new PaymentExpiredError({ expires: request.expires })

      const parsed = Methods.charge.schema.credential.payload.safeParse(credential.payload)
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
      const userMetadata = request.methodDetails?.metadata as Record<string, string> | undefined
      const resolvedMetadata = { ...buildAnalytics({ credential }), ...userMetadata }
      for (const [key, value] of Object.entries(resolvedMetadata)) {
        body.set(`metadata[${key}]`, value)
      }

      const response = await fetch('https://api.stripe.com/v1/payment_intents', {
        method: 'POST',
        headers: {
          Authorization: `Basic ${btoa(`${secretKey}:`)}`,
          'Content-Type': 'application/x-www-form-urlencoded',
          'Idempotency-Key': `mppx_${challenge.id}_${spt}`,
        },
        body,
      })

      if (!response.ok) throw new VerificationFailedError({ reason: 'Stripe PaymentIntent failed' })

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
  type Defaults = LooseOmit<Method.RequestDefaults<typeof Methods.charge>, 'recipient'>

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

/** @internal */
function buildAnalytics(parameters: { credential: Credential.Credential }): Record<string, string> {
  const { credential } = parameters
  const { challenge } = credential
  return {
    mpp_version: '1',
    mpp_is_mpp: 'true',
    mpp_intent: challenge.intent,
    mpp_challenge_id: challenge.id,
    mpp_server_id: challenge.realm,
    ...(credential.source ? { mpp_client_id: credential.source } : {}),
  }
}
