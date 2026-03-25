import type * as Credential from '../../Credential.js'
import {
  PaymentActionRequiredError,
  PaymentExpiredError,
  VerificationFailedError,
} from '../../Errors.js'
import type { LooseOmit, OneOf } from '../../internal/types.js'
import * as Method from '../../Method.js'
import type { StripeClient } from '../internal/types.js'
import * as Methods from '../Methods.js'
import { html } from './internal/html.gen.js'

export const createTokenPathname = '/__mppx_stripe_create_token'

/**
 * Creates a Stripe charge method intent for usage on the server.
 *
 * Verifies payment by creating a Stripe PaymentIntent with the provided SPT.
 *
 * Accepts either a `client` (a pre-configured Stripe SDK instance) or a raw
 * `secretKey`. Using `client` is recommended—it lets you configure retries,
 * API version, and other options on the Stripe instance you control.
 *
 * @example
 * ```ts
 * import Stripe from 'stripe'
 * import { stripe } from 'mppx/server'
 *
 * const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!)
 * const charge = stripe.charge({ client: stripeClient, networkId: 'internal', paymentMethodTypes: ['card'] })
 * ```
 *
 * @example
 * ```ts
 * import { stripe } from 'mppx/server'
 *
 * const charge = stripe.charge({ secretKey: 'sk_...', networkId: 'internal', paymentMethodTypes: ['card'] })
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
    publishableKey,
  } = parameters

  const client = 'client' in parameters ? parameters.client : undefined
  const secretKey = 'secretKey' in parameters ? parameters.secretKey : undefined

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

    ...(parameters.html === false
      ? { html: false }
      : publishableKey
        ? {
            html: {
              method: html,
              config: { publishableKey, createTokenUrl: createTokenPathname } satisfies HtmlConfig,
            },
            htmlRoutes: {
              [createTokenPathname]: async (request: globalThis.Request) => {
                const { paymentMethod, amount, currency, expiresAt, networkId, metadata } =
                  (await request.json()) as {
                    paymentMethod: string
                    amount: string
                    currency: string
                    expiresAt: number
                    networkId?: string
                    metadata?: Record<string, string>
                  }

                const body = new URLSearchParams({
                  payment_method: paymentMethod,
                  'usage_limits[currency]': currency,
                  'usage_limits[max_amount]': amount,
                  'usage_limits[expires_at]': expiresAt.toString(),
                })
                if (networkId) body.set('seller_details[network_id]', networkId)
                if (metadata) {
                  for (const [key, value] of Object.entries(metadata)) {
                    body.set(`metadata[${key}]`, value)
                  }
                }

                const resolvedSecretKey = secretKey ?? (client as any)?.apiKey
                if (!resolvedSecretKey)
                  return Response.json(
                    { error: 'secretKey is required for SPT creation' },
                    { status: 500 },
                  )

                const createSpt = async (bodyParams: URLSearchParams) =>
                  fetch('https://api.stripe.com/v1/test_helpers/shared_payment/granted_tokens', {
                    method: 'POST',
                    headers: {
                      Authorization: `Basic ${btoa(`${resolvedSecretKey}:`)}`,
                      'Content-Type': 'application/x-www-form-urlencoded',
                    },
                    body: bodyParams,
                  })

                try {
                  let response = await createSpt(body)
                  if (!response.ok) {
                    const error = (await response.json()) as { error: { message: string } }
                    if (
                      (metadata || networkId) &&
                      error.error.message.includes('Received unknown parameter')
                    ) {
                      const fallbackBody = new URLSearchParams({
                        payment_method: paymentMethod,
                        'usage_limits[currency]': currency,
                        'usage_limits[max_amount]': amount,
                        'usage_limits[expires_at]': expiresAt.toString(),
                      })
                      response = await createSpt(fallbackBody)
                    } else {
                      return Response.json({ error: error.error.message }, { status: 500 })
                    }
                  }

                  if (!response.ok) {
                    const error = (await response.json()) as { error: { message: string } }
                    return Response.json({ error: error.error.message }, { status: 500 })
                  }

                  const { id: spt } = (await response.json()) as { id: string }
                  return Response.json({ spt })
                } catch (e) {
                  const message = e instanceof Error ? e.message : 'Unknown error'
                  return Response.json({ error: message }, { status: 500 })
                }
              },
            },
          }
        : {}),

    async verify({ credential }) {
      const { challenge } = credential
      const { request } = challenge

      if (challenge.expires && new Date(challenge.expires) < new Date())
        throw new PaymentExpiredError({ expires: challenge.expires })

      const parsed = Methods.charge.schema.credential.payload.safeParse(credential.payload)
      if (!parsed.success) throw new Error('Invalid credential payload: missing or malformed spt')
      const { spt, externalId: credentialExternalId } = parsed.data as {
        spt: string
        externalId?: string
      }

      const userMetadata = request.methodDetails?.metadata as Record<string, string> | undefined
      const resolvedMetadata = { ...buildAnalytics({ credential }), ...userMetadata }

      const pi = client
        ? await createWithClient({ client, challenge, request, spt, metadata: resolvedMetadata })
        : await createWithSecretKey({
            secretKey: secretKey!,
            challenge,
            request,
            spt,
            metadata: resolvedMetadata,
          })

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

export type HtmlConfig = {
  createTokenUrl: string
  publishableKey: string
}

export declare namespace charge {
  type Defaults = LooseOmit<Method.RequestDefaults<typeof Methods.charge>, 'recipient'>

  type Parameters = {
    /** Disable the built-in HTML payment page for this method. @default true */
    html?: false | undefined
    /** Optional metadata to include in SPT creation requests. */
    metadata?: Record<string, string> | undefined
    /** Stripe publishable key for browser-based HTML payment form. Required when using `html: true` on Mppx.create. */
    publishableKey?: string | undefined
  } & Defaults &
    OneOf<
      | {
          /** Pre-configured Stripe SDK instance. Any object matching the duck-typed `StripeClient` shape works. */
          client: StripeClient
          /** Stripe secret API key. Required for HTML payment page SPT creation when using `client`. */
          secretKey?: string | undefined
        }
      | {
          /** Stripe secret API key. */
          secretKey: string
        }
    >

  type DeriveDefaults<parameters extends Parameters> = Pick<
    parameters,
    Extract<keyof parameters, keyof Defaults>
  > & { decimals: number }
}

/** Creates a PaymentIntent using the Stripe SDK client. */
async function createWithClient(parameters: {
  client: StripeClient
  challenge: { id: string }
  metadata: Record<string, string>
  request: { amount: unknown; currency: unknown }
  spt: string
}): Promise<{ id: string; status: string }> {
  const { client, challenge, metadata, request, spt } = parameters
  try {
    const result = await client.paymentIntents.create(
      {
        amount: Number(request.amount),
        automatic_payment_methods: { allow_redirects: 'never', enabled: true },
        confirm: true,
        currency: request.currency as string,
        metadata,
        // `shared_payment_granted_token` is not yet in the Stripe SDK types (SPTs are in private preview).
        shared_payment_granted_token: spt,
      } as any,
      { idempotencyKey: `mppx_${challenge.id}_${spt}` },
    )
    return { id: result.id, status: result.status }
  } catch {
    throw new VerificationFailedError({ reason: 'Stripe PaymentIntent failed' })
  }
}

/** Creates a PaymentIntent using a raw secret key and fetch. */
async function createWithSecretKey(parameters: {
  secretKey: string
  challenge: { id: string }
  metadata: Record<string, string>
  request: { amount: unknown; currency: unknown }
  spt: string
}): Promise<{ id: string; status: string }> {
  const { secretKey, challenge, metadata, request, spt } = parameters

  const body = new URLSearchParams({
    amount: request.amount as string,
    'automatic_payment_methods[allow_redirects]': 'never',
    'automatic_payment_methods[enabled]': 'true',
    confirm: 'true',
    currency: request.currency as string,
    shared_payment_granted_token: spt,
  })
  for (const [key, value] of Object.entries(metadata)) {
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
  return (await response.json()) as { id: string; status: string }
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
