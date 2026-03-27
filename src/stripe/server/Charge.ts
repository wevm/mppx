import type * as Credential from '../../Credential.js'
import {
  PaymentActionRequiredError,
  PaymentExpiredError,
  VerificationFailedError,
} from '../../Errors.js'
import type { LooseOmit, OneOf } from '../../internal/types.js'
import * as Method from '../../Method.js'
import * as z from '../../zod.js'
import type { StripeClient } from '../internal/types.js'
import * as Methods from '../Methods.js'
import { html } from './internal/html.gen.js'

export const createTokenPathname = '/__mppx_stripe_create_token'
const createSptPath = '/v1/test_helpers/shared_payment/granted_tokens'
const createSptRequestSchema = z.object({
  amount: z.string(),
  currency: z.string(),
  expiresAt: z.number(),
  metadata: z.optional(z.record(z.string(), z.string())),
  networkId: z.optional(z.string()),
  paymentMethod: z.string(),
})

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
    html: htmlConfig,
    metadata,
    networkId,
    paymentMethodTypes,
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

    ...(htmlConfig
      ? {
          html: {
            content: html,
            config: {
              publishableKey: htmlConfig.publishableKey,
              createTokenUrl: htmlConfig.createTokenUrl ?? createTokenPathname,
            } satisfies charge.HtmlConfig,
            routes: {
              [createTokenPathname]: (request: globalThis.Request) =>
                createTokenResponse({ request, client, secretKey }),
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

      if (pi.replayed)
        throw new VerificationFailedError({ reason: 'Payment has already been processed.' })

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
    /** Enable the built-in HTML payment page with Stripe configuration. */
    html?: { publishableKey: string; createTokenUrl?: string | undefined } | undefined
    /** Optional metadata to include in SPT creation requests. */
    metadata?: Record<string, string> | undefined
  } & Defaults &
    OneOf<
      | {
          /** Pre-configured Stripe SDK instance. Any object matching the duck-typed `StripeClient` shape works. */
          client: StripeClient
          /** Stripe secret API key used as a fallback for HTML SPT creation if the client does not expose `rawRequest()`. */
          secretKey?: string | undefined
        }
      | {
          /** Stripe secret API key. */
          secretKey: string
        }
    >

  type HtmlConfig = {
    createTokenUrl: string
    publishableKey: string
  }

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
}): Promise<{ id: string; status: string; replayed: boolean }> {
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
    // https://docs.stripe.com/error-low-level#idempotency
    const replayed = result.lastResponse?.headers?.['idempotent-replayed'] === 'true'
    return { id: result.id, status: result.status, replayed }
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
}): Promise<{ id: string; status: string; replayed: boolean }> {
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
  // https://docs.stripe.com/error-low-level#idempotency
  const replayed = response.headers.get('idempotent-replayed') === 'true'
  const result = (await response.json()) as { id: string; status: string }
  return { ...result, replayed }
}

async function createSpt(parameters: {
  client?: StripeClient | undefined
  parameters: Record<string, unknown>
  secretKey?: string | undefined
}): Promise<{ success: true; result: { id: string } } | { success: false; error: unknown } | null> {
  const { client, parameters: requestParameters, secretKey } = parameters

  if (client?.rawRequest) {
    try {
      const result = (await client.rawRequest('POST', createSptPath, requestParameters)) as {
        id: string
      }
      return { success: true, result }
    } catch (error) {
      return { success: false, error }
    }
  }

  if (!secretKey) return null

  const body = new URLSearchParams()
  appendFormFields(body, requestParameters)

  const response = await fetch(`https://api.stripe.com${createSptPath}`, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${btoa(`${secretKey}:`)}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body,
  })

  if (!response.ok) {
    const error = (await response.json()) as { error?: { message?: string } }
    return { success: false, error }
  }

  return { success: true, result: (await response.json()) as { id: string } }
}

/** @internal */
export async function createTokenResponse(parameters: {
  client?: StripeClient | undefined
  request: globalThis.Request
  secretKey?: string | undefined
}): Promise<globalThis.Response> {
  const { client, request, secretKey } = parameters

  const parsed = createSptRequestSchema.safeParse(await request.json())
  if (!parsed.success)
    return Response.json(
      {
        error: parsed.error.issues[0]?.message ?? 'Invalid Stripe create token request',
      },
      { status: 400 },
    )

  const { paymentMethod, amount, currency, expiresAt, networkId, metadata } = parsed.data

  try {
    let spt = await createSpt({
      client,
      parameters: buildCreateSptParameters({
        amount,
        currency,
        expiresAt,
        metadata,
        networkId,
        paymentMethod,
      }),
      secretKey,
    })
    if (!spt) throw new Error('client.rawRequest() or secretKey is required for SPT creation')

    if ((metadata || networkId) && !spt.success) {
      const message = getStripeErrorMessage(spt.error)
      if (message && message.includes('Received unknown parameter')) {
        spt = await createSpt({
          client,
          parameters: buildCreateSptParameters({
            amount,
            currency,
            expiresAt,
            paymentMethod,
          }),
          secretKey,
        })
      }
    }

    if (!spt?.success)
      return Response.json(
        { error: getStripeErrorMessage(spt?.error) ?? 'Unknown error' },
        { status: 500 },
      )

    return Response.json({ spt: spt.result.id })
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    return Response.json({ error: message }, { status: 500 })
  }
}

function buildCreateSptParameters(parameters: {
  amount: string
  currency: string
  expiresAt: number
  metadata?: Record<string, string> | undefined
  networkId?: string | undefined
  paymentMethod: string
}) {
  const { amount, currency, expiresAt, metadata, networkId, paymentMethod } = parameters

  return {
    payment_method: paymentMethod,
    usage_limits: {
      currency,
      expires_at: expiresAt,
      max_amount: amount,
    },
    ...(networkId ? { seller_details: { network_id: networkId } } : {}),
    ...(metadata ? { metadata } : {}),
  }
}

function appendFormFields(
  searchParams: URLSearchParams,
  value: Record<string, unknown> | unknown[],
  prefix?: string,
): void {
  if (Array.isArray(value)) {
    for (const [index, item] of value.entries())
      appendFormValue(searchParams, item, `${prefix ?? ''}[${index}]`)
    return
  }

  for (const [key, item] of Object.entries(value)) {
    appendFormValue(searchParams, item, prefix ? `${prefix}[${key}]` : key)
  }
}

function appendFormValue(searchParams: URLSearchParams, value: unknown, key: string): void {
  if (value == null) return
  if (Array.isArray(value)) {
    appendFormFields(searchParams, value, key)
    return
  }
  if (typeof value === 'object') {
    appendFormFields(searchParams, value as Record<string, unknown>, key)
    return
  }
  searchParams.set(key, String(value))
}

function getStripeErrorMessage(error: unknown): string | undefined {
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const message = (error as { error?: { message?: unknown } }).error?.message
    if (typeof message === 'string') return message
  }
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
