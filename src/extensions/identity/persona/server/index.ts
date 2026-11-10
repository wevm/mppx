import { verifyMessage } from 'viem'
import type { Address, Hex } from 'viem'

import type * as Challenge from '../../../../Challenge.js'
import type * as Credential from '../../../../Credential.js'
import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import type * as Store from '../../../../Store.js'
import { Constants } from '../Constants.js'
import * as Did from '../Did.js'
import type * as Types from '../Types.js'

/**
 * Creates a Persona client for one Persona organization and inquiry template.
 *
 * - `startInquiry` starts an inquiry for a reference ID and returns a one-time link to
 *   Persona's hosted flow.
 * - `paymentCheck` requires an approved inquiry on a route's paid retry, keyed by the payer.
 * - `verifier` requires one before any 402, keyed by your own session.
 *
 * Link a wallet to a person by proving they own it (`verifyWallet`) before you start an
 * inquiry with its DID as the reference ID. Otherwise anyone can complete KYC as themselves
 * for someone else's wallet.
 *
 * @example
 * ```ts
 * const persona = Persona.Server.create({ apiKey: env.PERSONA_API_KEY, templateId: 'itmpl_…' })
 *
 * app.post('/kyc', async (request) => {
 *   const referenceId = await Persona.Server.verifyWallet({ ...(await request.json()), nonce })
 *   return Response.json(await persona.startInquiry({ referenceId }))
 * })
 *
 * const kyc = persona.paymentCheck({ onboarding: 'https://api.example/kyc', cache: Store.memory() })
 * mppx.charge({ amount: '1', identity: { payment: kyc } })
 * ```
 */
export function create(config: create.Config): Persona {
  const {
    apiKey,
    apiUrl = Constants.apiUrl,
    apiVersion = Constants.apiVersion,
    fetch = globalThis.fetch,
    templateId,
    timeout = Constants.timeout,
  } = config
  if (!apiKey) throw new TypeError('Persona.Server.create needs an apiKey.')

  async function call(path: string, init: RequestInit = {}): Promise<unknown> {
    const response = await fetch(new URL(path, apiUrl), {
      ...init,
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'Persona-Version': apiVersion,
        ...(init.body !== undefined && { 'Content-Type': 'application/json' }),
      },
      signal: AbortSignal.timeout(timeout),
    })
    // Never surface the upstream body: it may carry request details.
    if (!response.ok) throw new PersonaError(`The Persona API returned ${response.status}.`)
    return response.json()
  }

  /** Returns the most recent accepted inquiry for a reference ID, or `undefined`. */
  async function find(
    referenceId: string,
    options: { statuses: readonly Types.InquiryStatus[]; maxAge?: number | undefined },
  ): Promise<Types.VerifiedInquiry | undefined> {
    const url = new URL(Constants.inquiriesPath, apiUrl)
    url.searchParams.set('filter[reference-id]', referenceId)
    url.searchParams.set('filter[status]', options.statuses.join(','))
    if (templateId) url.searchParams.set('filter[inquiry-template-id]', templateId)
    url.searchParams.set('page[size]', '25')
    let next: string | undefined = url.pathname + url.search
    const now = Date.now()
    for (let page = 0; next && page < Constants.maxPages; page++) {
      const body = (await call(next)) as { data?: unknown; links?: { next?: unknown } }
      if (!Array.isArray(body?.data))
        throw new PersonaError('The Persona API response is malformed.')
      // Persona lists the most recent inquiries first.
      for (const inquiry of body.data as Inquiry[]) {
        const attributes = inquiry?.attributes
        if (typeof inquiry?.id !== 'string' || !attributes) continue
        // Recheck what the filters asked for, so an API or proxy that ignores them cannot widen them.
        if (attributes['reference-id'] !== referenceId) continue
        const status = attributes.status as Types.InquiryStatus
        if (!options.statuses.includes(status)) continue
        const verifiedAt = date(attributes['decisioned-at'] ?? attributes['completed-at'])
        if (!fresh(verifiedAt, options.maxAge, now)) continue
        return Object.freeze({ inquiryId: inquiry.id, referenceId, status, verifiedAt })
      }
      next = typeof body.links?.next === 'string' ? body.links.next : undefined
    }
    return undefined
  }

  /** Looks a reference ID up, through the cache when set, and maps the result to a verification. */
  async function lookup(
    referenceId: string | undefined,
    options: LookupOptions,
    request: Request,
  ): Promise<Identity.Verification<Types.VerifiedInquiry>> {
    const { cache, cacheTtl = Constants.cacheTtl, maxAge, statuses = Constants.statuses } = options
    if (statuses.length === 0) throw new TypeError('Persona needs at least one accepted status.')
    const headers = await onboardingHeaders(options.onboarding, request, referenceId)
    if (!referenceId) return { status: 'missing', headers, reason: 'Persona KYC requires a payer.' }

    const key = `mppx:persona:${templateId ?? ''}:${referenceId}`
    const now = Date.now()
    const cached = cache ? ((await cache.get(key)) as CacheEntry | null) : null
    if (
      cached &&
      cached.expires > now &&
      statuses.includes(cached.status) &&
      fresh(date(cached.verifiedAt), maxAge, now)
    )
      return {
        status: 'valid',
        value: Object.freeze({
          inquiryId: cached.inquiryId,
          referenceId,
          status: cached.status,
          verifiedAt: date(cached.verifiedAt),
        }),
      }

    let inquiry: Types.VerifiedInquiry | undefined
    try {
      inquiry = await find(referenceId, { statuses, maxAge })
    } catch {
      return { status: 'unavailable', reason: 'Persona KYC verification is unavailable.' }
    }
    if (!inquiry)
      return { status: 'forbidden', headers, reason: 'The payer has not passed Persona KYC.' }
    // Only approvals are cached, so a person who just passed KYC is never kept waiting.
    if (cache)
      await cache.put(key, {
        expires: now + cacheTtl * 1_000,
        inquiryId: inquiry.inquiryId,
        status: inquiry.status,
        verifiedAt: inquiry.verifiedAt?.toISOString(),
      } satisfies CacheEntry)
    return { status: 'valid', value: inquiry }
  }

  return Object.freeze({
    async startInquiry(parameters) {
      const { redirectUri, referenceId } = parameters
      const inquiryTemplateId = parameters.templateId ?? templateId
      if (!referenceId) throw new TypeError('startInquiry needs a referenceId.')
      if (!inquiryTemplateId) throw new TypeError('startInquiry needs a templateId.')
      const created = (await call(Constants.inquiriesPath, {
        method: 'POST',
        body: JSON.stringify({
          data: {
            attributes: {
              'inquiry-template-id': inquiryTemplateId,
              'reference-id': referenceId,
              ...(redirectUri && { 'redirect-uri': redirectUri }),
            },
          },
        }),
      })) as { data?: { id?: unknown } }
      const inquiryId = created?.data?.id
      if (typeof inquiryId !== 'string')
        throw new PersonaError('The Persona API response is malformed.')
      const link = (await call(
        `${Constants.inquiriesPath}/${encodeURIComponent(inquiryId)}/generate-one-time-link`,
        { method: 'POST', body: '{}' },
      )) as { meta?: Record<string, unknown> }
      const url = link?.meta?.['one-time-link']
      if (typeof url !== 'string') throw new PersonaError('The Persona API response is malformed.')
      return Object.freeze({ inquiryId, url })
    },

    paymentCheck(options = {}) {
      const referenceId =
        options.referenceId ??
        (({ credential }: create.PaymentParameters) =>
          credential?.source ? Did.normalize(credential.source) : undefined)
      return Object.freeze({
        requires: Object.freeze([
          Object.freeze({ type: Constants.type, issuer: Constants.issuer }),
        ]),
        async verify(parameters) {
          return lookup(await referenceId(parameters), options, parameters.request)
        },
      })
    },

    verifier(options) {
      return Object.freeze({
        async verify(request: Request) {
          return lookup(await options.referenceId(request), options, request)
        },
      })
    },
  } satisfies Persona)
}

export declare namespace create {
  type Config = {
    /** Persona API key. Keep it on the server. */
    readonly apiKey: string
    /** Inquiry template (`itmpl_…`) to start inquiries from and to accept them from. */
    readonly templateId?: string | undefined
    /** Persona API origin. @default 'https://api.withpersona.com' */
    readonly apiUrl?: string | undefined
    /** `Persona-Version` header. @default '2023-01-05' */
    readonly apiVersion?: string | undefined
    /** Fetch used for the Persona API. */
    readonly fetch?: typeof globalThis.fetch | undefined
    /** Milliseconds before a Persona API call is abandoned. @default 5000 */
    readonly timeout?: number | undefined
  }

  /** What a payment check's `referenceId` receives. */
  type PaymentParameters = {
    readonly request: Request
    readonly challenge: Challenge.Challenge
    readonly credential?: Credential.Credential | undefined
  }
}

/** A Persona client from {@link create}. */
export type Persona = {
  /** Starts an inquiry for a reference ID and returns a one-time link to Persona's hosted flow. */
  readonly startInquiry: (parameters: {
    /** Reference ID to match later, such as `Persona.did(…)` of a wallet the person proved they own. */
    readonly referenceId: string
    /** Inquiry template, overriding the client's. */
    readonly templateId?: string | undefined
    /** Where Persona sends the person after the flow. */
    readonly redirectUri?: string | undefined
  }) => Promise<Types.StartedInquiry>
  /**
   * Returns a payment check that requires the payer to have passed Persona KYC.
   *
   * Every 402 of the route advertises `Identity-Required: kyc;issuer="https://api.withpersona.com"`.
   * On the paid retry, before the Credential settles, it accepts the most recent inquiry whose
   * reference ID is the payer's: by default the Credential's `source` DID (`Persona.did`). That
   * default trusts `source`, so use it with methods that reject a `source` other than the
   * actual payer, such as `tempo.charge`. On a route with `authorize`, which runs the check
   * without a Credential, pass a `referenceId` that reads your own session.
   *
   * No payer is `missing` (401), no accepted inquiry `forbidden` (403), both with `onboarding`
   * in a `Link` header; a Persona API failure is `unavailable` (503).
   */
  readonly paymentCheck: (
    options?: LookupOptions & {
      /** Returns the payer's reference ID, or `undefined` when there is none. */
      readonly referenceId?:
        | ((parameters: create.PaymentParameters) => MaybePromise<string | undefined>)
        | undefined
    },
  ) => Identity.PaymentCheck<Types.VerifiedInquiry>
  /**
   * Returns a request-stage verifier that requires an approved inquiry before any 402, for a
   * caller `referenceId` identifies from the request, such as by your own session.
   */
  readonly verifier: (
    options: LookupOptions & {
      /** Returns the caller's reference ID, or `undefined` when there is none. */
      readonly referenceId: (request: Request) => MaybePromise<string | undefined>
    },
  ) => Identity.Verifier<Types.VerifiedInquiry>
}

/** Options shared by {@link Persona.paymentCheck} and {@link Persona.verifier}. */
export type LookupOptions = {
  /** Accepted inquiry statuses. @default ['approved'] */
  readonly statuses?: readonly Types.InquiryStatus[] | undefined
  /** Oldest accepted verification, in seconds since the inquiry was decisioned or completed. */
  readonly maxAge?: number | undefined
  /**
   * Where a rejected payer starts KYC, sent as `Link: <url>; rel="kyc"` with 401 and 403
   * responses, such as your endpoint that calls `startInquiry`.
   */
  readonly onboarding?:
    | string
    | ((parameters: {
        readonly request: Request
        readonly referenceId: string | undefined
      }) => MaybePromise<string | undefined>)
    | undefined
  /** Caches approvals by reference ID, so a paid request skips the Persona API. */
  readonly cache?: Store.Store | undefined
  /** Seconds an approval stays cached. @default 300 */
  readonly cacheTtl?: number | undefined
}

/**
 * Verifies that the signer of `message` owns `address` and returns the wallet's reference ID
 * (`Persona.did`), to start an inquiry with. `message` must contain `nonce`: a single-use
 * value your server issued for this person, so a signature cannot be replayed.
 *
 * Without `verify`, it accepts EOA signatures only. Pass `verify` for smart accounts, such as
 * viem's `publicClient.verifyMessage`, which supports ERC-1271 and ERC-6492.
 */
export async function verifyWallet(parameters: verifyWallet.Parameters): Promise<string> {
  const { address, chainId, message, nonce, signature } = parameters
  if (!nonce || !message.includes(nonce))
    throw new TypeError('The signed message must contain the nonce.')
  const verify = parameters.verify ?? verifyMessage
  const valid = await verify({ address, message, signature }).catch(() => false)
  if (!valid) throw new TypeError('The signature does not match the address.')
  return Did.did({ address, chainId })
}

export declare namespace verifyWallet {
  type Parameters = {
    /** Wallet address the person claims. */
    readonly address: Address
    /** Chain ID of the wallet, such as `4217` for Tempo mainnet. */
    readonly chainId: number
    /** Message the wallet signed, containing `nonce`. */
    readonly message: string
    /** Signature over `message`. */
    readonly signature: Hex
    /** Single-use value your server issued and the message must contain. */
    readonly nonce: string
    /** Verifies the signature. Defaults to viem's `verifyMessage` (EOA only). */
    readonly verify?:
      | ((parameters: { address: Address; message: string; signature: Hex }) => Promise<boolean>)
      | undefined
  }
}

/** A failed or malformed Persona API call. */
export class PersonaError extends Error {
  override readonly name = 'PersonaError'
}

type Inquiry = {
  readonly id?: unknown
  readonly attributes?: Record<string, unknown> | undefined
}

type CacheEntry = {
  readonly expires: number
  readonly inquiryId: string
  readonly status: Types.InquiryStatus
  readonly verifiedAt?: string | undefined
}

async function onboardingHeaders(
  onboarding: LookupOptions['onboarding'],
  request: Request,
  referenceId: string | undefined,
): Promise<HeadersInit | undefined> {
  const url =
    typeof onboarding === 'function' ? await onboarding({ request, referenceId }) : onboarding
  if (!url) return undefined
  return { Link: `<${url}>; rel="${Constants.rel}"` }
}

function fresh(verifiedAt: Date | undefined, maxAge: number | undefined, now: number): boolean {
  if (maxAge === undefined) return true
  if (!(Number.isInteger(maxAge) && maxAge > 0))
    throw new RangeError('Persona maxAge must be a positive integer.')
  return verifiedAt !== undefined && now - verifiedAt.getTime() <= maxAge * 1_000
}

function date(value: unknown): Date | undefined {
  if (typeof value !== 'string') return undefined
  const parsed = new Date(value)
  return Number.isNaN(parsed.getTime()) ? undefined : parsed
}
