import {
  PaymentExpiredError,
  VerificationFailedError,
} from '../../Errors.js'
import type { OneOf } from '../../internal/types.js'
import * as Method from '../../Method.js'
import type { WhopClient, WhopCheckoutConfig, WhopPayment } from '../internal/types.js'
import * as Methods from '../Methods.js'

/**
 * Creates a Whop charge method intent for usage on the server.
 *
 * Verifies payment by retrieving the Whop payment via the public API.
 * The checkout configuration (purchase URL) must be created by the
 * handler and passed via `meta: { purchase_url }` so the client can
 * complete payment.
 *
 * @example
 * ```ts
 * import { Mppx, whop } from 'mppx/server'
 *
 * const mppx = Mppx.create({
 *   methods: [
 *     whop({
 *       apiKey: process.env.WHOP_API_KEY!,
 *       companyId: 'biz_xxx',
 *       currency: 'usd',
 *     }),
 *   ],
 * })
 *
 * app.get('/api/resource', async (req) => {
 *   const checkout = await whop.createCheckout({
 *     apiKey: process.env.WHOP_API_KEY!,
 *     companyId: 'biz_xxx',
 *     amount: 5.0,
 *     currency: 'usd',
 *   })
 *
 *   const result = await mppx.charge({
 *     amount: 5.0,
 *     meta: { purchase_url: checkout.purchase_url },
 *   })(req)
 *
 *   if (result.status === 402) return result.challenge
 *   return result.withReceipt(new Response('OK'))
 * })
 * ```
 */
export function charge<const parameters extends charge.Parameters>(parameters: parameters) {
  const { amount, companyId, currency, description } = parameters

  const client = 'client' in parameters ? parameters.client : undefined
  const apiKey = 'apiKey' in parameters ? parameters.apiKey : undefined

  type Defaults = charge.DeriveDefaults<parameters>
  return Method.toServer<typeof Methods.charge, Defaults>(Methods.charge, {
    defaults: { amount, companyId, currency, description } as unknown as Defaults,

    async verify({ credential }) {
      const { challenge } = credential

      if (challenge.expires && new Date(challenge.expires) < new Date())
        throw new PaymentExpiredError({ expires: challenge.expires })

      const parsed = Methods.charge.schema.credential.payload.safeParse(credential.payload)
      if (!parsed.success)
        throw new Error('Invalid credential payload: missing or malformed paymentId')
      const { paymentId, externalId } = parsed.data as {
        paymentId: string
        externalId?: string
      }

      // Retrieve payment from Whop's public API
      const payment = client
        ? await client.payments.retrieve(paymentId)
        : await fetchPayment(apiKey!, paymentId)

      // Verify payment status
      if (payment.status !== 'paid' && payment.status !== 'succeeded') {
        throw new VerificationFailedError({
          reason: `Whop payment status: ${payment.status}`,
        })
      }

      // Verify amount matches
      const expectedAmount = challenge.request.amount as number
      if (payment.total !== expectedAmount) {
        throw new VerificationFailedError({
          reason: `Payment amount mismatch: got ${payment.total}, expected ${expectedAmount}`,
        })
      }

      return {
        method: 'whop',
        status: 'success',
        timestamp: new Date().toISOString(),
        reference: paymentId,
        ...(externalId ? { externalId } : {}),
      } as const
    },
  })
}

export declare namespace charge {
  type Defaults = Method.RequestDefaults<typeof Methods.charge>

  type Parameters = {
    /** Payment amount in decimal units (e.g., 5.00 for $5). */
    amount?: number | undefined
    /** Merchant's Whop company ID (biz_xxx). */
    companyId: string
    /** ISO currency code (e.g., "usd"). */
    currency?: string | undefined
    /** Optional human-readable description. */
    description?: string | undefined
  } & OneOf<
    | { /** Pre-configured Whop SDK instance. */ client: WhopClient }
    | { /** Whop API key (Company or App API key). */ apiKey: string }
  >

  type DeriveDefaults<parameters extends Parameters> = Pick<
    parameters,
    Extract<keyof parameters, keyof Defaults>
  >
}

/**
 * Creates a Whop checkout configuration. Call this in your handler
 * and pass the `purchase_url` via `meta` so the client can complete payment.
 *
 * @example
 * ```ts
 * import { whop } from 'mppx/server'
 *
 * const checkout = await whop.createCheckout({
 *   apiKey: process.env.WHOP_API_KEY!,
 *   companyId: 'biz_xxx',
 *   amount: 5.0,
 *   currency: 'usd',
 *   redirectUrl: 'https://mysite.com/payment-complete',
 * })
 *
 * const result = await mppx.charge({
 *   amount: 5.0,
 *   meta: { purchase_url: checkout.purchase_url },
 * })(req)
 * ```
 */
export async function createCheckout(parameters: createCheckout.Parameters): Promise<WhopCheckoutConfig> {
  if ('client' in parameters && parameters.client) {
    try {
      return await parameters.client.checkoutConfigurations.create({
        company_id: parameters.companyId,
        plan: {
          initial_price: parameters.amount,
          plan_type: 'one_time',
          currency: parameters.currency ?? 'usd',
        },
        ...(parameters.description && {
          metadata: { description: parameters.description },
        }),
        ...(parameters.redirectUrl && { redirect_url: parameters.redirectUrl }),
      })
    } catch {
      throw new Error('Failed to create Whop checkout configuration')
    }
  }

  const apiKey = 'apiKey' in parameters ? parameters.apiKey : undefined
  if (!apiKey) throw new Error('Either client or apiKey is required')

  const body: Record<string, unknown> = {
    company_id: parameters.companyId,
    plan: {
      initial_price: parameters.amount,
      plan_type: 'one_time',
      currency: parameters.currency ?? 'usd',
    },
  }
  if (parameters.description) body.metadata = { description: parameters.description }
  if (parameters.redirectUrl) body.redirect_url = parameters.redirectUrl

  const response = await fetch('https://api.whop.com/api/v1/checkout_configurations', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })

  if (!response.ok) throw new Error('Failed to create Whop checkout configuration')
  return (await response.json()) as WhopCheckoutConfig
}

export declare namespace createCheckout {
  type Parameters = {
    /** Payment amount in decimal units (e.g., 5.00 for $5). */
    amount: number
    /** Merchant's Whop company ID (biz_xxx). */
    companyId: string
    /** ISO currency code. @default "usd" */
    currency?: string | undefined
    /** Optional description stored in checkout metadata. */
    description?: string | undefined
    /** URL to redirect after checkout. Payment ID appended as query param. */
    redirectUrl?: string | undefined
  } & OneOf<
    | { client: WhopClient }
    | { apiKey: string }
  >
}

/** Retrieves a payment using a raw API key and fetch. */
async function fetchPayment(apiKey: string, paymentId: string): Promise<WhopPayment> {
  const response = await fetch(`https://api.whop.com/api/v1/payments/${paymentId}`, {
    headers: { Authorization: `Bearer ${apiKey}` },
  })
  if (!response.ok)
    throw new VerificationFailedError({ reason: 'Failed to retrieve Whop payment' })
  return (await response.json()) as WhopPayment
}
