import * as Credential from '../../Credential.js'
import * as MethodIntent from '../../MethodIntent.js'
import * as z from '../../zod.js'
import * as Intents from '../Intents.js'

/**
 * Creates a Stripe charge method intent for usage on the client.
 *
 * Accepts a `createSpt` callback that handles SPT creation (requires
 * a secret key, so typically proxied through a server endpoint).
 *
 * The `paymentMethod` (e.g. from Stripe Elements) can be provided at
 * initialization or at credential-creation time via `context`.
 *
 * @example
 * ```ts
 * import { stripe } from 'mppx/client'
 *
 * const charge = stripe.charge({
 *   createSpt: async ({ paymentMethod, amount, currency, networkId, expiresAt, metadata }) => {
 *     const res = await fetch('/api/create-spt', {
 *       method: 'POST',
 *       headers: { 'Content-Type': 'application/json' },
 *       body: JSON.stringify({ paymentMethod, amount, currency, networkId, expiresAt, metadata }),
 *     })
 *     const { spt } = await res.json()
 *     return spt
 *   },
 * })
 *
 * // paymentMethod comes from Stripe Elements at credential-creation time
 * const credential = await charge.createCredential({
 *   challenge,
 *   context: { paymentMethod: 'pm_xxx' },
 * })
 * ```
 */
export function charge(parameters: charge.Parameters) {
  const { createSpt, externalId, paymentMethod: defaultPaymentMethod } = parameters

  return MethodIntent.toClient(Intents.charge, {
    context: z.object({
      paymentMethod: z.optional(z.string()),
    }),

    async createCredential({ challenge, context }) {
      const paymentMethod = context?.paymentMethod ?? defaultPaymentMethod
      if (!paymentMethod)
        throw new Error('paymentMethod is required (pass via context or parameters)')

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

      const spt = await createSpt({
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
    /**
     * Creates a Shared Payment Token (SPT) for the given parameters.
     *
     * SPT creation requires a Stripe secret key, so this typically
     * proxies through a server endpoint (e.g. `POST /api/create-spt`).
     * If you are running a client in an enviroment with a secret key, you can just create the
     * SPT directly in this callback.
     */
    createSpt: (parameters: CreateSptParameters) => Promise<string>
    /** Optional client-side external reference ID for the credential payload. */
    externalId?: string | undefined
    /** Default payment method ID. Overridden by `context.paymentMethod`. */
    paymentMethod?: string | undefined
  }

  type CreateSptParameters = {
    /** Stripe payment method ID (e.g. from Stripe Elements). */
    paymentMethod: string
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
