import type { MaybePromise } from '../internal/types.js'
import * as Status from './Status.js'
import type * as Types from './Types.js'

/**
 * Creates a request-stage verifier from a function, such as a lookup in your
 * own database, session store or KYC provider.
 *
 * `verify` returns the caller's identity, which the route handler reads with
 * `result.identity.get(verifier)`; `undefined` or `null` when the request carries none
 * (`missing`, 401, with `challenge` headers if set); or throws a {@link Rejection} to
 * reject the identity it carries.
 *
 * @example
 * ```ts
 * const customer = Identity.from({
 *   async verify(request) {
 *     const key = request.headers.get('X-Api-Key')
 *     if (!key) return undefined
 *     const row = await db.customerByKey(key)
 *     if (!row) throw new Identity.Rejection('Unknown API key.', { status: 'forbidden' })
 *     return row
 *   },
 * })
 * mppx.charge({ amount: '1', identity: [customer] })
 * ```
 */
export function from<value>(config: from.Config<value>): Types.Verifier<value> {
  return Object.freeze({
    async verify(request: Request): Promise<Types.Verification<value>> {
      let value: value | null | undefined
      try {
        value = await config.verify(request)
      } catch (error) {
        if (!(error instanceof Rejection)) throw error
        const { code, message: reason } = error
        // Fails closed: a status set at runtime outside the fixed rejections is `invalid`.
        const status = isRejectionStatus(error.status) ? error.status : 'invalid'
        if (status !== 'invalid') return { status, headers: config.challenge, reason }
        return {
          status,
          // A deprecated non-standard code is still sent as is.
          ...(code !== Status.codes.invalid && { code }),
          headers: config.challenge,
          reason,
        }
      }
      // A lookup that found nothing often returns null: treat it as no identity.
      if (value === undefined || value === null)
        return {
          status: 'missing',
          headers: config.challenge,
          reason: 'Identity verification is required.',
        }
      return { status: 'valid', value }
    },
  })
}

export declare namespace from {
  type Config<value> = {
    /**
     * Returns the request's verified identity, `undefined` or `null` when it carries none,
     * or throws a {@link Rejection} to reject the one it carries.
     */
    verify: (request: Request) => MaybePromise<value | null | undefined>
    /** Headers sent with a rejection, telling the client what identity to present. */
    challenge?: HeadersInit | undefined
  }
}

const rejectionStatuses = ['invalid', 'forbidden', 'unavailable'] as const

function isRejectionStatus(status: unknown): status is Rejection.Status {
  return (rejectionStatuses as readonly unknown[]).includes(status)
}

/** Rejects an identity a {@link from} verifier was given. */
export class Rejection extends Error {
  override readonly name = 'Rejection'
  /** Fixed status of the rejection. @default 'invalid' */
  readonly status: Rejection.Status
  /**
   * HTTP status of the rejection.
   *
   * @deprecated Read `status`. Defaults to the status's fixed code (`Identity.Status.codes`).
   */
  readonly code: number
  constructor(message: string, options: Rejection.Options = {}) {
    super(message)
    if (options.status !== undefined && !isRejectionStatus(options.status))
      throw new TypeError(
        `Identity rejection status must be one of ${rejectionStatuses.join(', ')}.`,
      )
    this.status =
      options.status ??
      (options.code === Status.codes.forbidden
        ? 'forbidden'
        : options.code === Status.codes.unavailable
          ? 'unavailable'
          : 'invalid')
    this.code = options.code ?? Status.codes[this.status]
  }
}

export declare namespace Rejection {
  /** Fixed statuses a {@link Rejection} can carry. */
  type Status = Exclude<Types.RejectionStatus, 'missing'>
  type Options = {
    /** Fixed status of the rejection. @default 'invalid' */
    status?: Status | undefined
    /**
     * HTTP status of the rejection.
     *
     * @deprecated Use `status`. 403 maps to `forbidden`, 503 to `unavailable`, and any other
     * code to `invalid`, sent with that code.
     */
    code?: number | undefined
  }
}
