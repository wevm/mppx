import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import { Constants } from '../Constants.js'
import type * as Types from '../Types.js'

/**
 * Creates a prover that answers Link attestation challenges with an Agent Attestation Token.
 *
 * When a server in `scope` answers 401 with `WWW-Authenticate: PrivateToken`, the prover gets a
 * token from `token` (such as `link-cli identity attestations pop`), and resends the request
 * with it in `Authorization`. Later requests to that origin, including paid retries, carry the
 * same token; a rejected one is replaced once. A request that already has an `Authorization`
 * header is left as it is.
 *
 * @example
 * ```ts
 * const mppx = Mppx.create({
 *   identity: [
 *     Link.Client.attestation({
 *       scope: ['https://api.example'],
 *       token: async () => (await linkCli('identity', 'attestations', 'pop')).authorization,
 *     }),
 *   ],
 *   methods: [tempo({ account })],
 * })
 * ```
 */
export function attestation(config: attestation.Config): Identity.Prover {
  const tokens = new Map<string, string>()
  return {
    scope: config.scope,
    async prove(request) {
      if (request.headers.has('Authorization')) return request
      const origin = new URL(request.url).origin
      if (config.eager && !tokens.has(origin)) {
        const token = await config.token({ origin })
        if (token) tokens.set(origin, toAuthorization(token))
      }
      const token = tokens.get(origin)
      if (!token) return request
      const headers = new Headers(request.headers)
      headers.set('Authorization', token)
      return new Request(request, { headers })
    },
    async retry(response, { request }) {
      if (response.status !== 401) return undefined
      if (!hasChallenge(response, Constants.attestationScheme)) return undefined
      const origin = new URL(request.url).origin
      const sent = request.headers.get('Authorization')
      // Someone else's Authorization: the token can't be sent alongside it.
      if (sent && sent !== tokens.get(origin)) return undefined
      tokens.delete(origin)
      const token = await config.token({ origin })
      if (!token) return undefined
      tokens.set(origin, toAuthorization(token))
      return {}
    },
  }
}

export declare namespace attestation {
  type Config = {
    /** Origins that may receive a token, or `'*'` for any origin. */
    readonly scope: Identity.Prover['scope']
    /**
     * Returns an unused token: Link CLI's `authorization` value (`PrivateToken token="…"`) or the
     * bare token. `undefined` declines.
     */
    readonly token: (parameters: { origin: string }) => MaybePromise<string | undefined>
    /**
     * Gets a token before the first request to an origin instead of after its challenge, so a
     * server that prices requests by the proofs they carry sees it from the start.
     * @default false
     */
    readonly eager?: boolean | undefined
  }
}

/**
 * Creates a prover that answers Link claims challenges with an identity presentation.
 *
 * When a server in `scope` answers 401 with `WWW-Authenticate: Identity-Presentation` and a
 * `urn:stripe:link:claims-required` body, the prover checks that the challenge names the
 * request's own origin as audience, trusts Link, and asks only for claims in `claims`. It then
 * gets a presentation from `present` (such as `link-cli identity credentials present`) and
 * resends the request with it in `Identity-Presentation`. Later requests to that origin carry
 * it until the server asks again.
 *
 * @example
 * ```ts
 * Link.Client.claims({
 *   claims: ['email', 'email_verified'],
 *   present: ({ audience, nonce, claims }) => linkCliPresent({ audience, nonce, claims }),
 *   scope: ['https://api.example'],
 * })
 * ```
 */
export function claims(config: claims.Config): Identity.Prover {
  const allowed = new Set(config.claims)
  const issuers = config.issuers ?? [Constants.issuer]
  const presentations = new Map<string, string>()
  return {
    scope: config.scope,
    headers: [Constants.presentationHeader.toLowerCase()],
    prove(request) {
      const presentation = presentations.get(new URL(request.url).origin)
      if (!presentation) return request
      const headers = new Headers(request.headers)
      headers.set(Constants.presentationHeader, presentation)
      return new Request(request, { headers })
    },
    async retry(response, { request }) {
      if (response.status !== 401) return undefined
      if (!hasChallenge(response, Constants.presentationHeader)) return undefined
      const origin = new URL(request.url).origin
      presentations.delete(origin)
      const challenge = await claimsChallenge(response)
      if (!challenge) return undefined
      // Bound to this origin only: a server can't relay another audience's challenge.
      if (challenge.aud.replace(/\/+$/, '') !== origin) return undefined
      if (!challenge.trusted_issuers.some((issuer) => issuers.includes(issuer))) return undefined
      if (!challenge.formats.includes(Constants.format)) return undefined
      if (!challenge.claims.every((claim) => allowed.has(claim))) return undefined
      const presentation = await config.present({
        audience: challenge.aud,
        claims: challenge.claims,
        nonce: challenge.nonce,
        purpose: challenge.purpose,
      })
      if (!presentation) return undefined
      presentations.set(origin, presentation)
      return {}
    },
  }
}

export declare namespace claims {
  type Config = {
    /** Origins that may receive a presentation, or `'*'` for any origin. */
    readonly scope: Identity.Prover['scope']
    /** Claims the prover may disclose, such as `['email', 'email_verified']`. */
    readonly claims: readonly string[]
    /** Creates a presentation for a challenge, or returns `undefined` to decline. */
    readonly present: Types.Present
    /** Issuers whose credentials may be presented. Override only for staging and tests. @default ['https://api.link.com'] */
    readonly issuers?: readonly string[] | undefined
  }
}

/** Parses a claims challenge's problem body, or returns `undefined` when it is not one. */
export async function claimsChallenge(
  response: Response,
): Promise<Types.ClaimsChallenge | undefined> {
  const body = (await response
    .clone()
    .json()
    .catch(() => undefined)) as Partial<Types.ClaimsChallenge> | undefined
  if (!body || body.type !== Constants.claimsRequiredType) return undefined
  const strings = (value: unknown): value is string[] =>
    Array.isArray(value) && value.every((item) => typeof item === 'string')
  if (typeof body.aud !== 'string' || typeof body.nonce !== 'string' || !body.nonce)
    return undefined
  if (!strings(body.claims) || body.claims.length === 0) return undefined
  if (!strings(body.formats) || !strings(body.trusted_issuers)) return undefined
  return {
    aud: body.aud,
    claims: body.claims,
    formats: body.formats,
    nonce: body.nonce,
    ...(typeof body.purpose === 'string' && { purpose: body.purpose }),
    trusted_issuers: body.trusted_issuers,
    type: body.type,
  }
}

/** Whether the response challenges with `scheme`. */
function hasChallenge(response: Response, scheme: string): boolean {
  const header = response.headers.get('WWW-Authenticate') ?? ''
  return new RegExp(`(^|,)\\s*${scheme}(\\s|,|$)`, 'i').test(header)
}

/** Link CLI's `authorization` value as is, or a bare token in the `PrivateToken` scheme. */
function toAuthorization(token: string): string {
  const value = token.trim()
  if (/^privatetoken\s/i.test(value)) return value
  return `${Constants.attestationScheme} token="${value}"`
}
