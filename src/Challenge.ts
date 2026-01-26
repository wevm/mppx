import { hmac } from '@noble/hashes/hmac.js'
import { sha256 } from '@noble/hashes/sha2.js'
import { Base64, Bytes } from 'ox'
import type { OneOf } from './internal/types.js'
import type * as MethodIntent from './MethodIntent.js'
import * as PaymentRequest from './PaymentRequest.js'
import * as z from './zod.js'

/**
 * Schema for a payment challenge.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mpay'
 *
 * const challenge = Challenge.Schema.parse(data)
 * ```
 */
export const Schema = z.object({
  /** Optional digest of the request body (format: "sha-256=base64hash"). */
  digest: z.optional(z.string().check(z.regex(/^sha-256=/, 'Invalid digest format'))),
  /** Optional expiration timestamp (ISO 8601). */
  expires: z.optional(z.datetime()),
  /** Unique challenge identifier (HMAC-bound). */
  id: z.string(),
  /** Intent type (e.g., "charge", "authorize"). */
  intent: z.string(),
  /** Payment method (e.g., "tempo", "stripe"). */
  method: z.string(),
  /** Server realm (e.g., hostname). */
  realm: z.string(),
  /** Method-specific request data. */
  request: z.record(z.string(), z.unknown()),
})

/**
 * A parsed payment challenge from a `WWW-Authenticate` header.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mpay'
 *
 * const challenge: Challenge.Challenge = {
 *   id: 'abc123',
 *   realm: 'api.example.com',
 *   method: 'tempo',
 *   intent: 'charge',
 *   request: { amount: '1000000', currency: '0x...', recipient: '0x...' },
 * }
 * ```
 */
export type Challenge<request = Record<string, unknown>, intent extends string = string> = Omit<
  z.infer<typeof Schema>,
  'intent' | 'request'
> & {
  intent: intent
  request: request
}

/**
 * Creates a challenge from the given parameters.
 *
 * If `secretKey` option is provided, the challenge ID is computed as HMAC-SHA256
 * over the challenge parameters (realm|method|intent|request|expires),
 * cryptographically binding the ID to its contents.
 *
 * @param parameters - Challenge parameters.
 * @param options - Optional settings including secretKey for HMAC-bound ID.
 * @returns A challenge.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mpay'
 *
 * // With HMAC-bound ID (recommended for servers)
 * const challenge = Challenge.from(
 *   {
 *     realm: 'api.example.com',
 *     method: 'tempo',
 *     intent: 'charge',
 *     request: { amount: '1000000', currency: '0x...', recipient: '0x...' },
 *   },
 *   { secretKey: 'my-secret' },
 * )
 *
 * // With explicit ID
 * const challenge = Challenge.from({
 *   id: 'abc123',
 *   realm: 'api.example.com',
 *   method: 'tempo',
 *   intent: 'charge',
 *   request: { amount: '1000000', currency: '0x...', recipient: '0x...' },
 * })
 * ```
 */
export function from<const parameters extends from.Parameters>(
  parameters: parameters,
): from.ReturnType<parameters> {
  const { digest, expires, method, intent, realm, request, secretKey } = parameters
  const id = secretKey ? computeId(parameters, { secretKey }) : (parameters as { id: string }).id

  return Schema.parse({
    id,
    realm,
    method,
    intent,
    request,
    ...(digest && { digest }),
    ...(expires && { expires }),
  }) as from.ReturnType<parameters>
}

export declare namespace from {
  type Parameters = OneOf<
    | {
        /** Explicit challenge ID. */
        id: string
      }
    | {
        /** Secret key for HMAC-bound challenge ID. */
        secretKey: string
      }
  > & {
    /** Optional digest of the request body. */
    digest?: string | undefined
    /** Optional expiration timestamp (ISO 8601). */
    expires?: string | undefined
    /** Intent type (e.g., "charge", "authorize"). */
    intent: string
    /** Payment method (e.g., "tempo", "stripe"). */
    method: string
    /** Server realm (e.g., hostname). */
    realm: string
    /** Method-specific request data. */
    request: PaymentRequest.Request
  }

  type ReturnType<parameters extends Parameters> = Challenge<parameters['request']>
}

/**
 * Creates a validated challenge from a method intent.
 *
 * If `secretKey` option is provided, the challenge ID is computed as HMAC-SHA256
 * over the challenge parameters, cryptographically binding the ID to its contents.
 *
 * @param intent - The method intent to validate against.
 * @param parameters - Challenge parameters (realm, request, optional expires/digest, and id if no secretKey).
 * @param options - Optional settings including secretKey for HMAC-bound ID.
 * @returns A validated challenge.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mpay'
 * import { Intents } from 'mpay/tempo'
 *
 * // With HMAC-bound ID (recommended for servers)
 * const challenge = Challenge.fromIntent(
 *   Intents.charge,
 *   {
 *     realm: 'api.example.com',
 *     request: {
 *       amount: '1000000',
 *       currency: '0x20c0000000000000000000000000000000000001',
 *       recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
 *       expires: '2025-01-06T12:00:00Z',
 *     },
 *   },
 *   { secretKey: 'my-secret' },
 * )
 * ```
 */
export function fromIntent<const intent extends MethodIntent.MethodIntent>(
  intent: intent,
  parameters: fromIntent.Parameters<intent>,
): fromIntent.ReturnType<intent> {
  const { method, name } = intent
  const { digest, expires, id, realm, secretKey } = parameters

  const request = PaymentRequest.fromIntent(intent, parameters.request)

  return from({
    ...(id ? { id } : { secretKey }),
    realm,
    method,
    intent: name,
    request,
    digest,
    expires,
  } as from.Parameters) as fromIntent.ReturnType<intent>
}

export declare namespace fromIntent {
  type Parameters<intent extends MethodIntent.MethodIntent> = OneOf<
    | {
        /** Explicit challenge ID. */
        id: string
      }
    | {
        /** Secret key for HMAC-bound challenge ID. */
        secretKey: string
      }
  > & {
    /** Optional digest of the request body. */
    digest?: string | undefined
    /** Optional expiration timestamp (ISO 8601). */
    expires?: string | undefined
    /** Server realm (e.g., hostname). */
    realm: string
    /** Method-specific request data. */
    request: z.input<intent['schema']['request']>
  }

  type ReturnType<intent extends MethodIntent.MethodIntent> = Challenge<
    z.output<intent['schema']['request']>
  >
}

/**
 * Serializes a challenge to the WWW-Authenticate header format.
 *
 * @param challenge - The challenge to serialize.
 * @returns A string suitable for the WWW-Authenticate header value.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mpay'
 *
 * const header = Challenge.serialize(challenge)
 * // => 'Payment id="abc123", realm="api.example.com", method="tempo", intent="charge", request="eyJhbW91bnQiOi..."'
 * ```
 */
export function serialize(challenge: Challenge): string {
  const parts = [
    `id="${challenge.id}"`,
    `realm="${challenge.realm}"`,
    `method="${challenge.method}"`,
    `intent="${challenge.intent}"`,
    `request="${PaymentRequest.serialize(challenge.request)}"`,
  ]

  if (challenge.digest !== undefined) parts.push(`digest="${challenge.digest}"`)
  if (challenge.expires !== undefined) parts.push(`expires="${challenge.expires}"`)

  return `Payment ${parts.join(', ')}`
}

/**
 * Deserializes a WWW-Authenticate header value to a challenge.
 *
 * @param header - The WWW-Authenticate header value.
 * @returns The deserialized challenge.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mpay'
 *
 * const challenge = Challenge.deserialize(header)
 * ```
 */
export function deserialize(value: string): Challenge {
  const prefixMatch = value.match(/^Payment\s+(.+)$/i)
  if (!prefixMatch?.[1]) throw new Error('Missing Payment scheme.')

  const params = prefixMatch[1]
  const result: Record<string, string> = {}

  for (const match of params.matchAll(/(\w+)="([^"]+)"/g)) {
    const key = match[1]
    const value = match[2]
    if (key && value) result[key] = value
  }

  const { request, ...rest } = result
  if (!request) throw new Error('Missing request parameter.')

  return from({
    ...rest,
    request: PaymentRequest.deserialize(request),
  } as from.Parameters)
}

/**
 * Extracts the challenge from a Headers object.
 *
 * @param headers - The HTTP headers.
 * @returns The deserialized challenge, or undefined if no WWW-Authenticate header.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mpay'
 *
 * const challenge = Challenge.fromHeaders(response.headers)
 * ```
 */
export function fromHeaders(headers: Headers): Challenge {
  const header = headers.get('WWW-Authenticate')
  if (!header) throw new Error('Missing WWW-Authenticate header.')
  return deserialize(header)
}

/**
 * Extracts the challenge from a Response's WWW-Authenticate header.
 *
 * @param response - The HTTP response (must be 402 status).
 * @returns The deserialized challenge.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mpay'
 *
 * const response = await fetch('/resource')
 * if (response.status === 402)
 *   const challenge = Challenge.fromResponse(response)
 * ```
 */
export function fromResponse(response: Response): Challenge {
  if (response.status !== 402) throw new Error('Response status is not 402.')
  return fromHeaders(response.headers)
}

/**
 * Verifies that a challenge ID matches the expected HMAC for the given parameters.
 *
 * @param challenge - The challenge to verify.
 * @param options - Options including the secret key.
 * @returns True if the challenge ID is valid, false otherwise.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mpay'
 *
 * const isValid = Challenge.verify(challenge, { secretKey: 'my-secret' })
 * ```
 */
export function verify(challenge: Challenge, options: verify.Options): boolean {
  const expectedId = computeId(challenge, options)
  return challenge.id === expectedId
}

export declare namespace verify {
  type Options = {
    /** Secret key for HMAC-bound challenge ID verification. */
    secretKey: string
  }
}

/** @internal Computes HMAC-SHA256 challenge ID from parameters. */
function computeId(challenge: Omit<Challenge, 'id'>, options: { secretKey: string }): string {
  const input = [
    challenge.realm,
    challenge.method,
    challenge.intent,
    PaymentRequest.serialize(challenge.request),
    challenge.expires ?? '',
    challenge.digest ?? '',
  ].join('|')

  const key = Bytes.fromString(options.secretKey)
  const data = Bytes.fromString(input)
  const mac = hmac(sha256, key, data)
  return Base64.fromBytes(mac, { url: true, pad: false })
}
