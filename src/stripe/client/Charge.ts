import type * as Challenge from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import * as Method from '../../Method.js'
import * as z from '../../zod.js'
import * as Methods from '../Methods.js'

/**
 * Creates a Stripe charge method intent for usage on the client.
 *
 * Accepts a `createToken` callback that handles SPT creation (requires
 * a secret key, so typically proxied through a server endpoint) and
 * returns a credential for retrying the request.
 *
 * The `paymentMethod` (e.g. from Stripe Elements) can be provided at
 * initialization or at credential-creation time via `context`.
 *
 * @example
 * ```ts
 * import { stripe } from 'mppx/client'
 *
 * const charge = stripe.charge({
 *   createToken: async ({ amount, currency, expiresAt, metadata, networkId, paymentMethod }) => {
 *     const res = await fetch('/api/create-spt', {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json' },
 *       body: JSON.stringify({ paymentMethod, amount, currency, networkId, expiresAt, metadata }),
 *     })
 *     const { spt } = await res.json()
 *     return spt
 *   },
 * })
 * ```
 */
export function charge(parameters: charge.Parameters) {
  const { createToken, externalId, paymentMethod: defaultPaymentMethod } = parameters

  return Method.toClient(Methods.charge, {
    context: z.object({
      paymentMethod: z.optional(z.string()),
    }),

    async createCredential({ challenge, context }) {
      const paymentMethod = context?.paymentMethod ?? defaultPaymentMethod
      if (!paymentMethod) {
        throw new Error('paymentMethod is required (pass via context or parameters)')
      }

      const amount = challenge.request.amount as string
      const currency = challenge.request.currency as string
      const networkId = challenge.request.methodDetails?.networkId as string | undefined
      if (!networkId) throw new Error('networkId is required in challenge.methodDetails')
      const metadata = challenge.request.methodDetails?.metadata as
        | Record<string, string>
        | undefined
      if (metadata?.externalId) {
        throw new Error(
          'methodDetails.metadata.externalId is reserved; use credential externalId instead',
        )
      }

      const expiresAt = challenge.request.expires
        ? Math.floor(new Date(challenge.request.expires as string).getTime() / 1000)
        : Math.floor(Date.now() / 1000) + 3600

      const spt = await createToken({
        challenge,
        paymentMethod,
        amount,
        currency,
        networkId,
        expiresAt,
        metadata,
      })

      return Credential.serialize({
        challenge,
        payload: {
          spt,
          ...(externalId ? { externalId } : {}),
        },
      })
    },
  })
}

export declare namespace charge {
  type Parameters = {
    /** Called when a Stripe challenge is received. Create an SPT to retry. */
    createToken: (parameters: OnChallengeParameters) => Promise<string>
    /** Optional client-side external reference ID for the credential payload. */
    externalId?: string | undefined
    /** Default payment method ID. Overridden by `context.paymentMethod`. */
    paymentMethod?: string | undefined
  }

  type OnChallengeParameters = {
    challenge: Challenge.Challenge<
      z.output<typeof Methods.charge.schema.request>,
      typeof Methods.charge.name,
      typeof Methods.charge.method
    >
    /** Stripe payment method ID (e.g. from Stripe Elements). */
    paymentMethod?: string | undefined
    /** Payment amount (in smallest currency unit). */
    amount: string
    /** Three-letter ISO currency code. */
    currency: string
    /** Stripe Business Network profile ID. */
    networkId: string | undefined
    /** SPT expiration as a Unix timestamp (seconds). */
    expiresAt: number
    /** Optional metadata to associate with the SPT. */
    metadata?: Record<string, string> | undefined
  }
}
