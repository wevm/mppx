import type * as Challenge from '../../Challenge.js'
import type * as Credential from '../../Credential.js'
import { PaymentActionRequiredError, VerificationFailedError } from '../../Errors.js'
import * as Expires from '../../Expires.js'
import type { LooseOmit, MaybePromise, OneOf } from '../../internal/types.js'
import * as Method from '../../Method.js'
import type * as Html from '../../server/internal/html/config.ts'
import type * as z from '../../zod.js'
import { stripePreviewVersion } from '../internal/constants.js'
import type {
  StripeClient,
  CreatePaymentMethodFromElements,
  StripeElementsOptionsMode,
  StripePaymentElementOptions,
} from '../internal/types.js'
import * as Methods from '../Methods.js'
import { html as htmlContent } from './internal/html.gen.js'

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
    html: { text: htmlText, theme: htmlTheme, ...htmlConfig } = {},
    metadata,
    networkId,
    paymentMethodTypes,
  } = parameters

  const client = 'client' in parameters ? parameters.client : undefined
  const connect = parameters.connect
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

    html:
      'publishableKey' in htmlConfig && htmlConfig.publishableKey && htmlConfig.createTokenUrl
        ? {
            config: htmlConfig,
            content: htmlContent,
            formatAmount: (request: z.output<typeof Methods.charge.schema.request>) => {
              try {
                const formatter = new Intl.NumberFormat('en', {
                  style: 'currency',
                  currency: request.currency,
                  currencyDisplay: 'narrowSymbol',
                })
                const decimals = formatter.resolvedOptions().maximumFractionDigits ?? 2
                return formatter.format(Number(request.amount) / 10 ** decimals)
              } catch {
                return `${request.currency}${request.amount}`
              }
            },
            text: htmlText,
            theme: htmlTheme,
          }
        : undefined,

    async verify({ credential, envelope, request }) {
      const { challenge } = credential
      const resolvedRequest = (() => {
        const parsed = Methods.charge.schema.request.safeParse(request)
        if (parsed.success) return parsed.data
        // verifyCredential() passes the HMAC-bound challenge request, which is
        // already in canonical output form and should not be transformed again.
        return request as unknown as z.output<typeof Methods.charge.schema.request>
      })()

      Expires.assert(challenge.expires, challenge.id)

      const parsed = Methods.charge.schema.credential.payload.safeParse(credential.payload)
      if (!parsed.success) throw new Error('Invalid credential payload: missing or malformed spt')
      const { spt, externalId: credentialExternalId } = parsed.data as {
        spt: string
        externalId?: string
      }

      const userMetadata = resolvedRequest.methodDetails?.metadata as
        | Record<string, string>
        | undefined
      const resolvedMetadata = { ...buildAnalytics({ credential }), ...userMetadata }
      const settlement = validateConnectSettlement({
        amount: resolvedRequest.amount,
        settlement:
          typeof connect === 'function'
            ? await connect({ challenge, credential, envelope, request: resolvedRequest })
            : connect,
      })

      const pi = client
        ? await createWithClient({
            client,
            challenge,
            request: resolvedRequest,
            spt,
            metadata: resolvedMetadata,
            settlement,
          })
        : await createWithSecretKey({
            secretKey: secretKey!,
            challenge,
            request: resolvedRequest,
            spt,
            metadata: resolvedMetadata,
            settlement,
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
    /** Render payment page when Accept header is text/html (e.g. in browsers) */
    html?:
      | ({
          createTokenUrl: string
          elements?:
            | {
                options?: StripeElementsOptionsMode | undefined
                paymentOptions?: StripePaymentElementOptions | undefined
                createPaymentMethodOptions?: CreatePaymentMethodFromElements | undefined
              }
            | undefined
          publishableKey: string
        } & Html.Config)
      | undefined
    /** Optional metadata to include in SPT creation requests. */
    metadata?: Record<string, string> | undefined
    /** Optional server-side Stripe Connect settlement policy. Not included in MPP challenges. */
    connect?: ConnectSettlement | ResolveConnectSettlement | undefined
  } & Defaults &
    OneOf<
      | {
          /** Pre-configured Stripe SDK instance. Any object matching the duck-typed `StripeClient` shape works. */
          client: StripeClient
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

  type ConnectSettlement = {
    /** Connected account used as the Stripe account context for the request. */
    stripeAccount?: string | undefined
    /** Platform application fee amount in the smallest currency unit. */
    applicationFeeAmount?: number | undefined
    /** Connected account used as the business of record. */
    onBehalfOf?: string | undefined
    /** Destination transfer created from the PaymentIntent. */
    transferData?: { amount?: number | undefined; destination: string } | undefined
    /** Reconciliation token linking related charges and transfers. */
    transferGroup?: string | undefined
  }

  type ResolveConnectSettlement = (parameters: {
    challenge: Challenge.Challenge<
      z.output<typeof Methods.charge.schema.request>,
      'charge',
      'stripe'
    >
    credential: Credential.Credential<
      z.output<typeof Methods.charge.schema.credential.payload>,
      Challenge.Challenge<z.output<typeof Methods.charge.schema.request>, 'charge', 'stripe'>
    >
    envelope?:
      | Method.VerifiedChallengeEnvelope<
          z.output<typeof Methods.charge.schema.request>,
          z.output<typeof Methods.charge.schema.credential.payload>,
          'charge',
          'stripe'
        >
      | undefined
    request: z.output<typeof Methods.charge.schema.request>
  }) => MaybePromise<ConnectSettlement | undefined>
}

/** Creates a PaymentIntent using the Stripe SDK client. */
async function createWithClient(parameters: {
  client: StripeClient
  challenge: { id: string }
  metadata: Record<string, string>
  request: { amount: unknown; currency: unknown }
  settlement: charge.ConnectSettlement | undefined
  spt: string
}): Promise<{ id: string; status: string; replayed: boolean }> {
  const { client, challenge, metadata, request, settlement, spt } = parameters
  try {
    const paymentIntentParams = {
      amount: Number(request.amount),
      automatic_payment_methods: { allow_redirects: 'never', enabled: true },
      confirm: true,
      currency: request.currency as string,
      metadata,
      ...(settlement?.applicationFeeAmount !== undefined && {
        application_fee_amount: settlement.applicationFeeAmount,
      }),
      ...(settlement?.onBehalfOf !== undefined && { on_behalf_of: settlement.onBehalfOf }),
      ...(settlement?.transferData !== undefined && {
        transfer_data: {
          destination: settlement.transferData.destination,
          ...(settlement.transferData.amount !== undefined && {
            amount: settlement.transferData.amount,
          }),
        },
      }),
      ...(settlement?.transferGroup !== undefined && { transfer_group: settlement.transferGroup }),
      // `shared_payment_granted_token` is not yet in the Stripe SDK types (SPTs are in private preview).
      shared_payment_granted_token: spt,
    }
    const paymentIntentOptions = {
      apiVersion: stripePreviewVersion,
      idempotencyKey: `mppx_${challenge.id}_${spt}`,
      ...(settlement?.stripeAccount !== undefined && { stripeAccount: settlement.stripeAccount }),
    }
    const result = await client.paymentIntents.create(
      paymentIntentParams as any,
      paymentIntentOptions,
    )
    // https://docs.stripe.com/error-low-level#idempotency
    const replayed = result.lastResponse?.headers?.['idempotent-replayed'] === 'true'
    return { id: result.id, status: result.status, replayed }
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    throw new VerificationFailedError({
      reason: `Stripe PaymentIntent failed: ${detail}`,
    })
  }
}

/** Creates a PaymentIntent using a raw secret key and fetch. */
async function createWithSecretKey(parameters: {
  secretKey: string
  challenge: { id: string }
  metadata: Record<string, string>
  request: { amount: unknown; currency: unknown }
  settlement: charge.ConnectSettlement | undefined
  spt: string
}): Promise<{ id: string; status: string; replayed: boolean }> {
  const { secretKey, challenge, metadata, request, settlement, spt } = parameters

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
  if (settlement?.applicationFeeAmount !== undefined)
    body.set('application_fee_amount', String(settlement.applicationFeeAmount))
  if (settlement?.onBehalfOf !== undefined) body.set('on_behalf_of', settlement.onBehalfOf)
  if (settlement?.transferData !== undefined) {
    body.set('transfer_data[destination]', settlement.transferData.destination)
    if (settlement.transferData.amount !== undefined)
      body.set('transfer_data[amount]', String(settlement.transferData.amount))
  }
  if (settlement?.transferGroup !== undefined) body.set('transfer_group', settlement.transferGroup)

  const headers = {
    Authorization: `Basic ${btoa(`${secretKey}:`)}`,
    'Content-Type': 'application/x-www-form-urlencoded',
    'Idempotency-Key': `mppx_${challenge.id}_${spt}`,
    'Stripe-Version': stripePreviewVersion,
    ...(settlement?.stripeAccount !== undefined && { 'Stripe-Account': settlement.stripeAccount }),
  }

  const response = await fetch('https://api.stripe.com/v1/payment_intents', {
    method: 'POST',
    headers,
    body,
  })

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    const detail = (() => {
      try {
        const parsed = JSON.parse(body) as { error?: { message?: string } }
        return parsed.error?.message ?? body
      } catch {
        return body
      }
    })()
    throw new VerificationFailedError({
      reason: `Stripe PaymentIntent failed: ${detail}`,
    })
  }
  // https://docs.stripe.com/error-low-level#idempotency
  const replayed = response.headers.get('idempotent-replayed') === 'true'
  const result = (await response.json()) as { id: string; status: string }
  return { ...result, replayed }
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

function validateConnectSettlement(parameters: {
  amount: unknown
  settlement: charge.ConnectSettlement | undefined
}): charge.ConnectSettlement | undefined {
  const { amount, settlement } = parameters
  if (settlement === undefined) return undefined

  const paymentAmount = Number(amount)
  if (!Number.isSafeInteger(paymentAmount) || paymentAmount < 0)
    throw new VerificationFailedError({ reason: 'Stripe amount must be a non-negative integer.' })

  validateAccountId(settlement.stripeAccount, 'stripeAccount')
  validateAccountId(settlement.onBehalfOf, 'onBehalfOf')
  validateAmount(settlement.applicationFeeAmount, paymentAmount, 'applicationFeeAmount')

  if (settlement.transferData !== undefined) {
    validateRequiredAccountId(settlement.transferData.destination, 'transferData.destination')
    validateAmount(settlement.transferData.amount, paymentAmount, 'transferData.amount')
  }

  return settlement
}

function validateAccountId(value: string | undefined, name: string) {
  if (value !== undefined && value.length === 0)
    throw new VerificationFailedError({ reason: `Stripe Connect ${name} must be non-empty.` })
}

function validateRequiredAccountId(value: string | undefined, name: string) {
  if (value === undefined || value.length === 0)
    throw new VerificationFailedError({ reason: `Stripe Connect ${name} must be non-empty.` })
}

function validateAmount(value: number | undefined, paymentAmount: number, name: string) {
  if (value === undefined) return
  if (!Number.isSafeInteger(value) || value < 0)
    throw new VerificationFailedError({
      reason: `Stripe Connect ${name} must be a non-negative integer.`,
    })
  if (value > paymentAmount)
    throw new VerificationFailedError({
      reason: `Stripe Connect ${name} must be less than or equal to the PaymentIntent amount.`,
    })
}
