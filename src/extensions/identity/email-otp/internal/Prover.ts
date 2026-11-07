import { isInnerList, parseList, Token } from 'structured-headers'

import type * as Identity from '../../../../identity/Types.js'
import type { MaybePromise } from '../../../../internal/types.js'
import * as Attestation from './Attestation.js'
import { Constants } from './Constants.js'
import type * as Types from './Types.js'

/**
 * Creates a prover that presents identity attestations.
 *
 * On each in-scope request it sends, in `Identity-Attestation`, every unexpired
 * attestation whose audience is the request's origin. When a server answers
 * 401 or 403 with `Identity-Attestation-Required`, it calls `acquire` for each
 * listed type and issuer it accepts, keeps the result, and the request is sent
 * once more.
 *
 * The audience is always the request's own origin, never one a server names,
 * so a server cannot obtain an attestation it could replay elsewhere. `acquire`
 * runs only for the listed `issuers`.
 *
 * @example
 * ```ts
 * Mppx.create({ identity: [Attestation.Client.prover({ scope: '*', attestations: [token] })], methods })
 * ```
 */
export function prover(config: prover.Config): Identity.Prover {
  const stored = new Map<string, { claims: Types.Claims; token: string }>()
  const pending = new Map<string, Promise<boolean>>()
  const keyOf = (claims: Pick<Types.Claims, 'aud' | 'iss' | 'type'>) =>
    JSON.stringify([claims.aud, claims.iss, claims.type])

  function decode(token: string): Types.Claims {
    const claims = Attestation.decode(token)?.claims
    if (
      !claims ||
      typeof claims.aud !== 'string' ||
      typeof claims.iss !== 'string' ||
      typeof claims.type !== 'string' ||
      typeof claims.exp !== 'number'
    )
      throw new TypeError('Identity attestation is malformed.')
    return claims as Types.Claims
  }
  function add(token: string, claims: Types.Claims = decode(token)) {
    stored.set(keyOf(claims), { claims, token })
  }
  for (const token of config.attestations ?? []) add(token)

  const now = () => Math.floor(Date.now() / 1_000)
  if (config.acquire && !config.issuers)
    throw new TypeError('An attestation prover that acquires attestations must list its issuers.')

  return {
    scope: config.scope,
    prove(request) {
      const origin = new URL(request.url).origin
      const tokens = [...stored.values()]
        .filter(({ claims }) => claims.aud === origin && claims.exp > now())
        .map(({ token }) => token)
      if (tokens.length === 0) return request
      const headers = new Headers(request.headers)
      const existing = headers.get(Constants.header)
      headers.set(Constants.header, [existing, ...tokens].filter(Boolean).join(', '))
      return new Request(request, { headers })
    },
    async retry(response) {
      if (response.status !== 401 && response.status !== 403) return false
      if (!config.acquire || !URL.canParse(response.url)) return false
      const audience = new URL(response.url).origin
      let acquired = false
      for (const { type, issuer } of requirements(response.headers)) {
        // Only trusted issuers: a server-named one could relay a code and obtain an
        // attestation for another origin.
        if (!issuer || !config.issuers?.includes(issuer)) continue
        if (config.types && !config.types.includes(type)) continue
        const key = keyOf({ aud: audience, iss: issuer, type })
        let task = pending.get(key)
        if (!task) {
          // A stored attestation the server rejected is replaced.
          stored.delete(key)
          task = (async () => {
            const token = await config.acquire!({ audience, issuer, type })
            if (!token) return false
            const claims = decode(token)
            // Store only an attestation for this requirement, so an issuer cannot plant one.
            if (claims.aud !== audience || claims.iss !== issuer || claims.type !== type)
              return false
            add(token, claims)
            return true
          })().finally(() => pending.delete(key))
          pending.set(key, task)
        }
        if (await task) acquired = true
      }
      return acquired
    },
  }
}

export declare namespace prover {
  type Config = {
    /** Origins that receive attestations, or `'*'` for any origin. */
    scope: Identity.Prover['scope']
    /** Attestations obtained beforehand, such as from an issuer with curl. */
    attestations?: readonly string[] | undefined
    /** Obtains an attestation a server requires, or returns `undefined` to decline. */
    acquire?:
      | ((requirement: {
          /** Origin the attestation must be bound to. */
          audience: string
          /** Issuer to obtain it from. */
          issuer: string
          /** Attestation type. */
          type: string
        }) => MaybePromise<string | undefined>)
      | undefined
    /** Issuers `acquire` may be asked for. Required with `acquire`. */
    issuers?: readonly string[] | undefined
    /** Attestation types `acquire` may be asked for. Defaults to any. */
    types?: readonly string[] | undefined
  }
}

/** Parses the attestation requirements of a rejected response. */
export function requirements(headers: Headers): Types.Requirement[] {
  const value = headers.get(Constants.requiredHeader)
  if (!value) return []
  let list
  try {
    list = parseList(value)
  } catch {
    return []
  }
  const result: Types.Requirement[] = []
  for (const member of list) {
    if (isInnerList(member) || !(member[0] instanceof Token)) continue
    const issuer = member[1].get('issuer')
    if (issuer === undefined) {
      result.push({ type: member[0].toString() })
      continue
    }
    if (typeof issuer !== 'string' || !isIssuer(issuer)) continue
    result.push({ type: member[0].toString(), issuer })
  }
  return result
}

/** Accepts https issuers, and http only on localhost for development. */
function isIssuer(value: string): boolean {
  if (!URL.canParse(value)) return false
  const url = new URL(value)
  if (url.protocol === 'https:') return true
  return url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1')
}
