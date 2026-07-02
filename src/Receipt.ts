import { Base64 } from 'ox'

import * as Constants from './Constants.js'
import * as z from './zod.js'

const shape = {
  /** Payment method used (e.g., "tempo", "stripe"). */
  method: z.string(),
  /** Method-specific reference (e.g., transaction hash). */
  reference: z.string(),
  /** Optional external reference ID echoed from the credential payload. */
  externalId: z.optional(z.string()),
  /** Optional server-issued subscription identifier for recurring payments. */
  subscriptionId: z.optional(z.string()),
  /** Payment status. Always "success" — failures use 402 + Problem Details. */
  status: z.literal('success'),
  /** RFC 3339 settlement timestamp. */
  timestamp: z.datetime(),
}

/** Base-field schema used only to derive the {@link Receipt} type without an index signature. */
const BaseSchema = z.object(shape)

/**
 * Schema for a payment receipt.
 *
 * Method specifications may define additional receipt fields beyond the
 * base set (per the core spec's Payment-Receipt section); unknown fields
 * are preserved through parse/serialize round-trips rather than stripped.
 *
 * @example
 * ```ts
 * import { Receipt } from 'mppx'
 *
 * const receipt = Receipt.Schema.parse(data)
 * ```
 */
export const Schema = z.looseObject(shape)

/**
 * Payment receipt returned after verification.
 *
 * Method-specific extension fields are preserved at runtime but not part of
 * this base type; method packages can type them via intersection
 * (e.g. `Receipt.Receipt & { originTxHash: string }`).
 *
 * @example
 * ```ts
 * import { Receipt } from 'mppx'
 *
 * const receipt: Receipt.Receipt = {
 *   method: 'tempo',
 *   status: 'success',
 *   timestamp: new Date().toISOString(),
 *   reference: '0x...',
 * }
 * ```
 */
export type Receipt = z.infer<typeof BaseSchema>

/**
 * Deserializes a Payment-Receipt header value to a receipt.
 *
 * @param encoded - The base64url-encoded header value.
 * @returns The deserialized receipt.
 *
 * @example
 * ```ts
 * import { Receipt } from 'mppx'
 *
 * const receipt = Receipt.deserialize(encoded)
 * ```
 */
export function deserialize(encoded: string): Receipt {
  const json = Base64.toString(encoded)
  return from(JSON.parse(json))
}

/**
 * Creates a receipt from the given parameters.
 *
 * @param parameters - Receipt parameters.
 * @returns A receipt.
 *
 * @example
 * ```ts
 * import { Receipt } from 'mppx'
 *
 * const receipt = Receipt.from({
 *   method: 'tempo',
 *   status: 'success',
 *   timestamp: new Date().toISOString(),
 *   reference: '0x...',
 * })
 * ```
 */
export function from(parameters: from.Parameters): Receipt {
  return Schema.parse(parameters)
}

export declare namespace from {
  type Parameters = z.input<typeof Schema>
}

/**
 * Serializes a receipt to the Payment-Receipt header format.
 *
 * @param receipt - The receipt to serialize.
 * @returns A base64url-encoded string suitable for the Payment-Receipt header value.
 *
 * @example
 * ```ts
 * import { Receipt } from 'mppx'
 *
 * const header = Receipt.serialize(receipt)
 * // => "eyJzdGF0dXMiOiJzdWNjZXNzIiwidGltZXN0YW1wIjoi..."
 * ```
 */
export function serialize(receipt: Receipt): string {
  const json = JSON.stringify(receipt)
  return Base64.fromString(json, { pad: false, url: true })
}

/**
 * Extracts the receipt from a Response's Payment-Receipt header.
 *
 * @param response - The HTTP response.
 * @returns The deserialized receipt.
 *
 * @example
 * ```ts
 * import { Receipt } from 'mppx'
 *
 * const response = await fetch('/resource', {
 *   headers: { Authorization: Credential.serialize(credential) },
 * })
 * if (response.ok) {
 *   const receipt = Receipt.fromResponse(response)
 * }
 * ```
 */
export function fromResponse(response: Response): Receipt {
  const header = response.headers.get(Constants.Headers.paymentReceipt)
  if (!header) throw new Error(`Missing ${Constants.Headers.paymentReceipt} header.`)
  return deserialize(header)
}
