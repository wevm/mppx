import type * as Challenge from '../../../../Challenge.js'
import type * as Credential from '../../../../Credential.js'
import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import { Constants } from '../Constants.js'
import type * as Types from '../Types.js'

/**
 * Creates a payment check that requires the payer to have passed Persona KYC.
 *
 * Every 402 of the route advertises `Identity-Required: kyc;issuer="https://withpersona.com"`.
 * On the paid retry, before the Credential settles, the check lists the Persona inquiries whose
 * reference ID is the payer's (by default the Credential's `source` DID, lowercased) and accepts
 * the most recent one with an accepted status. Create each payer's inquiry with that reference ID,
 * such as `did:pkh:eip155:4217:0xab…`, and send them its hosted flow.
 *
 * A payer without a reference ID is `missing` (401), one without an accepted inquiry is
 * `forbidden` (403), and a Persona API failure is `unavailable` (503).
 *
 * The default reference ID trusts the Credential's `source`, so use it with methods that reject
 * a `source` other than the actual payer, such as `tempo.charge`. Otherwise derive the reference
 * ID from your own session with `referenceId`.
 *
 * @example
 * ```ts
 * const kyc = Persona.Server.check({ apiKey: process.env.PERSONA_API_KEY! })
 * const result = await mppx.charge({ amount: '1', identity: { payment: kyc } })(request)
 * if (result.status === 200) result.identity?.get(kyc)?.inquiryId
 * ```
 */
export function check(config: check.Config): Identity.PaymentCheck<Types.VerifiedInquiry> {
  const {
    apiKey,
    apiUrl = Constants.apiUrl,
    fetch = globalThis.fetch,
    maxAge,
    statuses = Constants.statuses,
    templateId,
    timeout = Constants.timeout,
  } = config
  if (!apiKey) throw new TypeError('Persona.Server.check needs an apiKey.')
  if (statuses.length === 0) throw new TypeError('Persona.Server.check needs at least one status.')
  if (maxAge !== undefined && !(Number.isInteger(maxAge) && maxAge > 0))
    throw new RangeError('Persona maxAge must be a positive integer.')
  const referenceId =
    config.referenceId ??
    (({ credential }: check.ReferenceIdParameters) => credential?.source?.toLowerCase())

  return Object.freeze({
    requires: Object.freeze([Object.freeze({ type: Constants.type, issuer: Constants.issuer })]),
    async verify(parameters) {
      const reference = await referenceId(parameters)
      if (!reference) return { status: 'missing', reason: 'Persona KYC requires a payer.' }

      const url = new URL(Constants.inquiriesPath, apiUrl)
      url.searchParams.set('filter[reference-id]', reference)
      url.searchParams.set('filter[status]', statuses.join(','))
      if (templateId) url.searchParams.set('filter[inquiry-template-id]', templateId)
      url.searchParams.set('page[size]', '10')

      let inquiries: readonly Inquiry[]
      try {
        const response = await fetch(url, {
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${apiKey}`,
            'Persona-Version': Constants.apiVersion,
          },
          signal: AbortSignal.timeout(timeout),
        })
        if (!response.ok) return unavailable
        const body = (await response.json()) as { data?: unknown }
        if (!Array.isArray(body.data)) return unavailable
        inquiries = body.data as Inquiry[]
      } catch {
        // Never surface the upstream error: it may carry request details.
        return unavailable
      }

      const now = Date.now()
      // Persona lists the most recent inquiries first.
      for (const inquiry of inquiries) {
        const attributes = inquiry?.attributes
        if (typeof inquiry?.id !== 'string' || !attributes) continue
        // Recheck what the filters asked for, so a misbehaving API or proxy cannot widen them.
        if (attributes['reference-id'] !== reference) continue
        if (!statuses.includes(attributes.status as string)) continue
        const verifiedAt = date(attributes['decisioned-at'] ?? attributes['completed-at'])
        if (maxAge !== undefined && (!verifiedAt || now - verifiedAt.getTime() > maxAge * 1_000))
          continue
        return {
          status: 'valid',
          value: Object.freeze({
            inquiryId: inquiry.id,
            referenceId: reference,
            status: attributes.status as string,
            verifiedAt,
          }),
        }
      }
      return { status: 'forbidden', reason: 'The payer has not passed Persona KYC.' }
    },
  })
}

export declare namespace check {
  type Config = {
    /** Persona API key. Keep it on the server. */
    readonly apiKey: string
    /**
     * Returns the reference ID the payer's inquiry was created with, or `undefined` when the
     * request has no payer. Defaults to the Credential's `source` DID, lowercased. Without a
     * Credential (a route's `authorize`), the default returns `undefined`.
     */
    readonly referenceId?:
      | ((parameters: ReferenceIdParameters) => MaybePromise<string | undefined>)
      | undefined
    /** Accepted inquiry statuses. @default ['approved'] */
    readonly statuses?: readonly string[] | undefined
    /** Accepts only inquiries from this inquiry template, such as `itmpl_…`. */
    readonly templateId?: string | undefined
    /** Oldest accepted verification, in seconds since the inquiry was decisioned or completed. */
    readonly maxAge?: number | undefined
    /** Persona API origin. @default 'https://api.withpersona.com' */
    readonly apiUrl?: string | undefined
    /** Fetch used for the Persona API. */
    readonly fetch?: typeof globalThis.fetch | undefined
    /** Milliseconds before a Persona API call is abandoned as `unavailable`. @default 5000 */
    readonly timeout?: number | undefined
  }

  type ReferenceIdParameters = {
    readonly request: Request
    readonly challenge: Challenge.Challenge
    readonly credential?: Credential.Credential | undefined
  }
}

type Inquiry = {
  readonly id?: unknown
  readonly attributes?: Record<string, unknown> | undefined
}

const unavailable = Object.freeze({
  status: 'unavailable',
  reason: 'Persona KYC verification is unavailable.',
} as const)

function date(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}
