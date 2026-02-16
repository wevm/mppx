import { createRequire } from 'node:module'
import { Base64 } from 'ox'
import type { Compute } from './internal/types.js'
import type * as Method from './Method.js'
import type * as z from './zod.js'

const require = createRequire(import.meta.url)
const canonicalize = require('canonicalize') as (input: unknown) => string | undefined

/**
 * Intent-specific payment parameters.
 *
 * @example
 * ```ts
 * import { Request } from 'mppx'
 *
 * const request: Request.Request = {
 *   amount: '1000000',
 *   currency: '0x20c0000000000000000000000000000000000001',
 *   recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
 * }
 * ```
 */
export type Request<request extends Record<string, unknown> = Record<string, unknown>> =
  Compute<request>

/**
 * Deserializes a base64url string to a request.
 *
 * @param encoded - The base64url-encoded string.
 * @returns The deserialized request.
 *
 * @example
 * ```ts
 * import { Request } from 'mppx'
 *
 * const request = Request.deserialize(serialized)
 * ```
 */
export function deserialize(encoded: string): Request {
  const json = Base64.toString(encoded)
  return JSON.parse(json)
}

/**
 * Creates a request from the given parameters.
 *
 * @param request - Request parameters.
 * @returns A request.
 *
 * @example
 * ```ts
 * import { Request } from 'mppx'
 *
 * const request = Request.from({
 *   amount: '1000000',
 *   currency: '0x20c0000000000000000000000000000000000001',
 *   recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
 * })
 * ```
 */
export function from<const request extends Request>(request: request): request {
  return request
}

/**
 * Creates a validated request from a method intent.
 *
 * @param method - The method to validate against.
 * @param request - Request parameters.
 * @returns A validated request.
 *
 * @example
 * ```ts
 * import { Request } from 'mppx'
 * import { Methods } from 'mppx/tempo'
 *
 * const request = Request.fromIntent(Methods.charge, {
 *   amount: '1000000',
 *   currency: '0x20c0000000000000000000000000000000000001',
 *   recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
 *   expires: '2025-01-06T12:00:00Z',
 *   chainId: 42431,
 * })
 * ```
 */
export function fromIntent<const method extends Method.Method>(
  method: method,
  request: z.input<method['schema']['request']>,
): Request<z.output<method['schema']['request']>> {
  return method.schema.request.parse(request) as Request<z.output<method['schema']['request']>>
}

/**
 * Serializes a request to a base64url string.
 *
 * @param request - The request to serialize.
 * @returns A base64url-encoded string (no padding).
 *
 * @example
 * ```ts
 * import { Request } from 'mppx'
 *
 * const serialized = Request.serialize(request)
 * // => "eyJhbW91bnQiOiIxMDAwMDAwIiwiY3VycmVuY3kiOiIweC4uLiJ9"
 * ```
 */
export function serialize(request: Request): string {
  const json = canonicalize(request)
  if (!json) throw new Error('Failed to canonicalize request')
  return Base64.fromString(json, { pad: false, url: true })
}
