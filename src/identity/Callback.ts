import type { MaybePromise } from '../internal/types.js'
import type * as Types from './Types.js'

/**
 * Creates a request-stage verifier from a function, such as a lookup in your
 * own database, session store or KYC provider.
 *
 * `verify` returns the caller's identity, which the route handler reads with
 * `result.identity.get(verifier)`; `undefined` when the request carries none
 * (401, with `challenge` headers if set); or throws a {@link Rejection} to
 * reject the identity it carries.
 *
 * @example
 * ```ts
 * const customer = Identity.from({
 *   async verify(request) {
 *     const key = request.headers.get('X-Api-Key')
 *     if (!key) return undefined
 *     const row = await db.customerByKey(key)
 *     if (!row) throw new Identity.Rejection('Unknown API key.', { code: 403 })
 *     return row
 *   },
 * })
 * mppx.charge({ amount: '1', identity: [customer] })
 * ```
 */
export function from<value>(config: from.Config<value>): Types.Verifier<value> {
  return {
    stage: 'request',
    async verify(request) {
      let value: value | undefined
      try {
        value = await config.verify(request)
      } catch (error) {
        if (!(error instanceof Rejection)) throw error
        return {
          status: 'invalid',
          code: error.code,
          headers: config.challenge,
          reason: error.message,
        }
      }
      if (value === undefined)
        return {
          status: 'missing',
          code: 401,
          headers: config.challenge,
          reason: 'Identity verification is required.',
        }
      return { status: 'valid', value }
    },
  }
}

export declare namespace from {
  type Config<value> = {
    /**
     * Returns the request's verified identity, `undefined` when it carries none,
     * or throws a {@link Rejection} to reject the one it carries.
     */
    verify: (request: Request) => MaybePromise<value | undefined>
    /** Headers sent with a rejection, telling the client what identity to present. */
    challenge?: HeadersInit | undefined
  }
}

/** Rejects an identity a {@link from} verifier was given. */
export class Rejection extends Error {
  override readonly name = 'Rejection'
  /** HTTP status of the rejection. @default 401 */
  readonly code: number
  constructor(message: string, options: { code?: number | undefined } = {}) {
    super(message)
    this.code = options.code ?? 401
  }
}
