import type { MaybePromise } from '../../internal/types.js'
import type { SubscriptionIdentity } from './Types.js'

type IdentityExtractor = (parameters: {
  input: Request
  request: Record<string, unknown>
}) => MaybePromise<SubscriptionIdentity | null>

/**
 * Extracts identity from a request header value.
 *
 * @example
 * ```ts
 * subscription({ getIdentity: Identity.fromHeader('X-User-Id'), ... })
 * ```
 */
export function fromHeader(name: string): IdentityExtractor {
  return ({ input }) => {
    const value = input.headers.get(name)?.trim()
    return value ? { id: value } : null
  }
}

/**
 * Extracts identity from a Bearer token in the Authorization header using
 * a decoder function (e.g. JWT verification).
 *
 * @example
 * ```ts
 * subscription({
 *   getIdentity: Identity.fromBearer(async (token) => {
 *     const claims = await verifyJwt(token)
 *     return claims.sub
 *   }),
 *   ...
 * })
 * ```
 */
export function fromBearer(
  decode: (token: string) => MaybePromise<string | null>,
): IdentityExtractor {
  return async ({ input }) => {
    const auth = input.headers.get('Authorization')
    if (!auth) return null
    const match = /^Bearer\s+(.+)$/i.exec(auth)
    if (!match?.[1]) return null
    const id = await decode(match[1])
    return id ? { id } : null
  }
}

/**
 * Extracts identity from a wallet address in a request header.
 * Accepts raw `0x…` addresses or `did:pkh:eip155:…` DIDs.
 * The identity ID is the lowercased wallet address.
 *
 * @example
 * ```ts
 * subscription({ getIdentity: Identity.fromWallet('X-Wallet-Address'), ... })
 * ```
 */
export function fromWallet(headerName: string): IdentityExtractor {
  return ({ input }) => {
    const value = input.headers.get(headerName)?.trim()
    if (!value) return null
    const address = /^0x[0-9a-f]{40}$/i.test(value)
      ? value
      : /^did:pkh:eip155:\d+:(0x[0-9a-f]{40})$/i.exec(value)?.[1]
    return address ? { id: address.toLowerCase() } : null
  }
}
