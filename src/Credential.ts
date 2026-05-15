import { Base64 } from 'ox'

import * as Challenge from './Challenge.js'
import * as PaymentRequest from './PaymentRequest.js'

/**
 * A payment credential containing the challenge and payment proof.
 */
export type Credential<
  payload = unknown,
  challenge extends Challenge.Challenge = Challenge.Challenge,
> = {
  /** The challenge from the 402 response. */
  challenge: challenge
  /** Method-specific payment proof. */
  payload: payload
  /** Optional payer identifier as a DID (e.g., "did:pkh:eip155:1:0x..."). */
  source?: string
}

export class MissingAuthorizationHeaderError extends Error {
  override readonly name = 'MissingAuthorizationHeaderError'

  constructor() {
    super('Missing Authorization header.')
  }
}

export class MissingPaymentSchemeError extends Error {
  override readonly name = 'MissingPaymentSchemeError'

  constructor() {
    super('Missing Payment scheme.')
  }
}

export class InvalidCredentialEncodingError extends Error {
  override readonly name = 'InvalidCredentialEncodingError'

  constructor() {
    super('Invalid base64url or JSON.')
  }
}

/**
 * Deserializes an Authorization header value to a credential.
 * Accepts the spec-compliant base64url `opaque` string shape and the legacy
 * object-shaped `opaque` form emitted by older mppx versions.
 *
 * @param header - The Authorization header value.
 * @returns The deserialized credential.
 *
 * @example
 * ```ts
 * import { Credential } from 'mppx'
 *
 * const credential = Credential.deserialize(header)
 * ```
 */
export function deserialize<payload = unknown>(value: string): Credential<payload> {
  const prefixMatch = value.match(/^Payment\s+(.+)$/i)
  if (!prefixMatch?.[1]) throw new MissingPaymentSchemeError()
  try {
    const json = Base64.toString(prefixMatch[1])
    const parsed = JSON.parse(json) as {
      challenge: Omit<Challenge.Challenge, 'meta' | 'opaque' | 'request'> & {
        meta?: unknown
        opaque?: unknown
        request: string
      }
      payload: payload
      source?: string
    }
    const { opaque: challengeOpaque, request, meta: _meta, ...challengeFields } = parsed.challenge
    const { meta, opaque } = normalizeCredentialOpaque(challengeOpaque)
    const challenge = Challenge.Schema.parse({
      ...challengeFields,
      ...(meta !== undefined && { meta }),
      ...(opaque !== undefined && { opaque }),
      request: PaymentRequest.deserialize(request),
    })
    return {
      challenge,
      payload: parsed.payload,
      ...(parsed.source && { source: parsed.source }),
    } as Credential<payload>
  } catch {
    throw new InvalidCredentialEncodingError()
  }
}

function normalizeCredentialOpaque(value: unknown): {
  meta?: Record<string, string> | undefined
  opaque?: string | undefined
} {
  if (value === undefined) return {}
  if (typeof value === 'string') return { opaque: value }
  if (!isStringRecord(value)) throw new Error('Invalid opaque.')

  // Older mppx clients emitted credential challenge `opaque` as an expanded
  // object. Keep accepting that legacy shape, but normalize it back to the
  // spec-required base64url string.
  return {
    meta: value,
    opaque: PaymentRequest.serialize(value),
  }
}

function isStringRecord(value: unknown): value is Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  return Object.values(value).every((entry) => typeof entry === 'string')
}

/**
 * Creates a credential from the given parameters.
 *
 * @param parameters - Credential parameters with a Challenge object.
 * @returns A credential.
 *
 * @example
 * ```ts
 * import { Credential, Challenge } from 'mppx'
 *
 * const credential = Credential.from({
 *   challenge,
 *   payload: { signature: '0x...' },
 * })
 * ```
 */
export function from<const parameters extends from.Parameters>(
  parameters: parameters,
): Credential<parameters['payload'], parameters['challenge']> {
  const { challenge, payload, source } = parameters
  return {
    challenge,
    payload,
    ...(source && { source }),
  } as Credential<parameters['payload'], parameters['challenge']>
}

export declare namespace from {
  type Parameters = {
    /** The challenge from the 402 response. */
    challenge: Challenge.Challenge
    /** Method-specific payment proof. */
    payload: unknown
    /** Optional payer identifier as a DID (e.g., "did:pkh:eip155:1:0x..."). */
    source?: string
  }
}

/**
 * Extracts the credential from a Request's Authorization header.
 *
 * @param request - The HTTP request.
 * @returns The deserialized credential.
 *
 * @example
 * ```ts
 * import { Credential } from 'mppx'
 *
 * const credential = Credential.fromRequest(request)
 * ```
 */
export function fromRequest<payload = unknown>(request: Request): Credential<payload> {
  const header = request.headers.get('Authorization')
  if (!header) throw new MissingAuthorizationHeaderError()
  const payment = extractPaymentScheme(header)
  if (!payment) throw new MissingPaymentSchemeError()
  return deserialize<payload>(payment)
}

/**
 * Serializes a credential to the Authorization header format.
 * When present, `challenge.opaque` is emitted unchanged as the base64url string
 * required by the Payment auth credential format.
 *
 * @param credential - The credential to serialize.
 * @returns A string suitable for the Authorization header value.
 *
 * @example
 * ```ts
 * import { Credential } from 'mppx'
 *
 * const header = Credential.serialize(credential)
 * // => 'Payment eyJjaGFsbGVuZ2UiOnsi...'
 * ```
 */
export function serialize(credential: Credential): string {
  const { meta, opaque, request, ...challenge } = credential.challenge
  const wireOpaque = opaque ?? (meta !== undefined ? PaymentRequest.serialize(meta) : undefined)
  const wire = {
    challenge: {
      ...challenge,
      ...(wireOpaque !== undefined && { opaque: wireOpaque }),
      request: PaymentRequest.serialize(request),
    },
    payload: credential.payload,
    ...(credential.source && { source: credential.source }),
  }
  const json = JSON.stringify(wire)
  const encoded = Base64.fromString(json, { pad: false, url: true })
  return `Payment ${encoded}`
}

/**
 * Extracts the `Payment` scheme from an Authorization header value
 * that may contain multiple schemes (comma-separated per RFC 9110).
 *
 * @param header - The raw Authorization header value.
 * @returns The `Payment ...` scheme string, or `null` if not found.
 */
export function extractPaymentScheme(header: string): string | null {
  const schemes = header.split(',').map((s) => s.trim())
  return schemes.find((s) => /^Payment\s+/i.test(s)) ?? null
}
