import { verifyMessage } from 'viem'
import type { Address, Hex } from 'viem'

import type * as Challenge from '../../../../Challenge.js'
import { unwrapFetch, withoutPayment } from '../../../../client/internal/Fetch.js'
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
 * const kyc = persona.paymentCheck({
 *   referenceId: ({ request }) => session(request)?.wallet, // a DID from verifyWallet
 *   onboarding: 'https://api.example/kyc',
 *   cache: Store.memory(),
 * })
 * mppx.charge({ amount: '1', identity: { payment: kyc } })
 * ```
 */
export function create(config: create.Config): Persona {
  const {
    apiKey,
    apiUrl = Constants.apiUrl,
    apiVersion = Constants.apiVersion,
    templateId,
    timeout = Constants.timeout,
  } = config
  if (!apiKey) throw new TypeError('Persona.Server.create needs an apiKey.')
  // AbortSignal.timeout throws on these at request time, and Node clamps delays above 2^31 - 1 ms
  // to 1 ms: either would read as a Persona outage.
  if (!Number.isSafeInteger(timeout) || timeout <= 0 || timeout > 2_147_483_647)
    throw new TypeError('Persona.Server.create needs a positive integer timeout in milliseconds.')

  // A digest of the API origin and key: identifies the Persona organization without storing the key.
  const scope = digest(`${new URL(apiUrl).origin}\n${apiKey}`)

  async function call(path: string, init: RequestInit = {}): Promise<unknown> {
    // Unwrapped, and resolved per call: a Persona request must never pay a Payment Challenge,
    // even when an mppx client polyfilled globalThis.fetch.
    const fetch = unwrapFetch(config.fetch ?? globalThis.fetch)
    const response = await fetch(
      new URL(path, apiUrl),
      withoutPayment({
        ...init,
        // A redirect is a failure: never send the bearer key on, nor read another origin's body.
        redirect: 'manual',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${apiKey}`,
          'Persona-Version': apiVersion,
          ...(init.body !== undefined && { 'Content-Type': 'application/json' }),
        },
        signal: AbortSignal.timeout(timeout),
      }),
    )
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
        // Fails closed when the inquiry does not name its template.
        if (templateId && inquiry.relationships?.['inquiry-template']?.data?.id !== templateId)
          continue
        const verifiedAt = date(attributes['decisioned-at'] ?? attributes['completed-at'])
        if (!fresh(verifiedAt, options.maxAge, now)) continue
        return Object.freeze({ inquiryId: inquiry.id, referenceId, status, verifiedAt })
      }
      next = sameOrigin(body.links?.next, apiUrl)
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

    // Scoped to the Persona organization and environment, so clients sharing a Store never
    // accept each other's approvals.
    const key = `mppx:persona:${await scope}:${templateId ?? ''}:${referenceId}`
    const now = Date.now()
    const cached = cache ? ((await cache.get(key)) as CacheEntry | null) : null
    if (
      cached &&
      // Each check applies its own lifetime, so a longer-lived check sharing the Store never
      // extends a stricter one's revalidation window.
      cached.cachedAt + cacheTtl * 1_000 > now &&
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
        cachedAt: now,
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

    paymentCheck(options) {
      const { referenceId } = options
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
   * reference ID `referenceId` returns. Derive it from something your server authenticated, such
   * as your own session, or a payer address your payment method verified. A Credential's
   * `source` is client-supplied and some payment flows do not check it against the payer, so
   * returning it as is lets a payer present another wallet's KYC. On a route with `authorize`,
   * the check runs without a Credential.
   *
   * No payer is `missing` (401), no accepted inquiry `forbidden` (403), both with `onboarding`
   * in a `Link` header; a Persona API failure is `unavailable` (503).
   */
  readonly paymentCheck: (
    options: LookupOptions & {
      /** Returns the payer's authenticated reference ID, or `undefined` when there is none. */
      readonly referenceId: (
        parameters: create.PaymentParameters,
      ) => MaybePromise<string | undefined>
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
 * (`Persona.did`), to start an inquiry with. `message` must contain `nonce`, a single-use
 * value your server issued for this person, so a signature cannot be replayed, and the wallet's
 * DID, so the signer commits to the chain.
 *
 * Without `verify`, it accepts EOA signatures only. Pass `verify` for smart accounts, such as
 * viem's `publicClient.verifyMessage` on `chainId`, which supports ERC-1271 and ERC-6492.
 */
export async function verifyWallet(parameters: verifyWallet.Parameters): Promise<string> {
  const { address, chainId, message, nonce, signature } = parameters
  if (!nonce || !message.includes(nonce))
    throw new TypeError('The signed message must contain the nonce.')
  const referenceId = Did.did({ address, chainId })
  // The signer commits to the chain as well as the address: the same address can have different
  // owners on different chains.
  if (!message.toLowerCase().includes(referenceId.toLowerCase()))
    throw new TypeError(`The signed message must contain the wallet's DID, ${referenceId}.`)
  const verify = parameters.verify ?? verifyMessage
  const valid = await verify({ address, chainId, message, signature }).catch(() => false)
  if (!valid) throw new TypeError('The signature does not match the address.')
  return referenceId
}

export declare namespace verifyWallet {
  type Parameters = {
    /** Wallet address the person claims. */
    readonly address: Address
    /** Chain ID of the wallet, such as `4217` for Tempo mainnet. */
    readonly chainId: number
    /** Message the wallet signed, containing `nonce` and the wallet's DID (`Persona.did`). */
    readonly message: string
    /** Signature over `message`. */
    readonly signature: Hex
    /** Single-use value your server issued and the message must contain. */
    readonly nonce: string
    /** Verifies the signature. Defaults to viem's `verifyMessage` (EOA only). */
    readonly verify?:
      | ((parameters: {
          address: Address
          chainId: number
          message: string
          signature: Hex
        }) => Promise<boolean>)
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
  readonly relationships?:
    | { readonly 'inquiry-template'?: { readonly data?: { readonly id?: unknown } | null } }
    | undefined
}

type CacheEntry = {
  readonly cachedAt: number
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

async function digest(value: string): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))
  return Array.from(new Uint8Array(hash).slice(0, 16), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('')
}

/**
 * Returns a pagination link as a path, or `undefined` unless it is on the Persona API origin, so
 * the API key is never sent to an origin a response names.
 */
function sameOrigin(link: unknown, apiUrl: string): string | undefined {
  if (typeof link !== 'string') return undefined
  const base = new URL(apiUrl)
  const url = new URL(link, base)
  if (url.origin !== base.origin) return undefined
  // The absolute URL, not its path: a path such as '//host/x' would resolve to another origin.
  return url.href
}
