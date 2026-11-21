import { Base64, Bytes, Hash } from 'ox'

import * as Constants from './Constants.js'
import { constantTimeEqual } from './internal/constantTimeEqual.js'
import type { OneOf } from './internal/types.js'
import type * as Method from './Method.js'
import * as PaymentRequest from './PaymentRequest.js'
import * as z from './zod.js'

const maxRequestParameterLength = 16 * 1024

const unsupportedCredentialHeaderMessage =
  'Unsupported credential header: challenges may only select Payment-Authorization.'

/**
 * Thrown when a challenge selects a credential header other than `Payment-Authorization`.
 * List parsing skips such challenges so the client can still pay another one.
 *
 * @internal
 */
class UnsupportedCredentialHeaderError extends Error {
  override readonly name = 'UnsupportedCredentialHeaderError'

  constructor() {
    super(unsupportedCredentialHeaderMessage)
  }
}

/**
 * Schema for a payment challenge.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mppx'
 *
 * const challenge = Challenge.Schema.parse(data)
 * ```
 */
export const Schema = z.object({
  /** Optional human-readable description of the payment. */
  description: z.optional(z.string()),
  /** Optional digest of the request body (format: "sha-256=base64hash"). */
  digest: z.optional(z.string().check(z.regex(/^sha-256=/, 'Invalid digest format'))),
  /** Optional expiration timestamp (ISO 8601). */
  expires: z.optional(z.datetime()),
  /**
   * Optional HTTP field name to carry the payment credential. When omitted, uses Authorization.
   * When present, it MUST be `Payment-Authorization`, matched case-insensitively. The spelling is
   * kept as received, because clients echo it unchanged and the challenge ID binds it.
   */
  header: z.optional(
    z.string().check(z.refine(isPaymentAuthorizationHeader, unsupportedCredentialHeaderMessage)),
  ),
  /** Unique challenge identifier (HMAC-bound). */
  id: z.string().check(z.minLength(1)),
  /** Intent type (e.g., "charge", "session"). */
  intent: z.string(),
  /** Payment method (e.g., "tempo", "stripe"). */
  method: z.string(),
  /** Optional parsed server-defined correlation data. */
  meta: z.optional(z.record(z.string(), z.string())),
  /** Optional server-defined correlation data. Raw base64url string; clients MUST NOT modify. */
  opaque: z.optional(z.string()),
  /** Server realm (e.g., hostname). */
  realm: z.string(),
  /** Method-specific request data. */
  request: z.record(z.string(), z.unknown()),
})

/**
 * Schema for a payment challenge whose `header` may be any string. Use it to read challenges stored
 * before `header` was limited to `Payment-Authorization`, or to check that a received challenge is
 * well formed before skipping it for its credential header.
 *
 * @internal
 */
export const LenientSchema = z.extend(Schema, {
  /** Optional HTTP field name to carry the payment credential, unchecked. */
  header: z.optional(z.string()),
})

/**
 * A parsed payment challenge from a `WWW-Authenticate` header.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mppx'
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
export type Challenge<
  request = Record<string, unknown>,
  intent extends string = string,
  method extends string = string,
> = Omit<z.infer<typeof Schema>, 'intent' | 'method' | 'request'> & {
  intent: intent
  method: method
  request: request
}

/**
 * Extracts a union of challenge types from an array of methods.
 */
export type FromMethods<methods extends readonly Method.Method[]> = {
  [method in keyof methods]: Challenge<
    z.output<methods[method]['schema']['request']>,
    methods[method]['intent'],
    methods[method]['name']
  >
}[number]

/**
 * Creates a challenge from the given parameters.
 *
 * If `secretKey` option is provided, the challenge ID is computed as HMAC-SHA256
 * over the canonical challenge ID input
 * (`realm|method|intent|request|expires|digest|opaque`),
 * cryptographically binding the ID to its contents.
 *
 * @param parameters - Challenge parameters.
 * @param options - Optional settings including secretKey for HMAC-bound ID.
 * @returns A challenge.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mppx'
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
export function from<
  const parameters extends from.Parameters,
  const methods extends readonly Method.Method[] | undefined = undefined,
>(parameters: parameters, options?: from.Options<methods>): from.ReturnType<parameters, methods> {
  void options
  const {
    description,
    digest,
    meta,
    method: methodName,
    header: suppliedHeader,
    intent,
    realm,
    request,
    secretKey,
  } = parameters

  // `Authorization` is the implicit protocol default and is intentionally not
  // advertised on the wire. This preserves the legacy challenge binding and
  // lets servers opt into `Payment-Authorization` explicitly.
  const header = normalizeCredentialHeader(suppliedHeader)

  const expires = parameters.expires ? z.toDatetimeString(parameters.expires) : undefined
  const opaque =
    parameters.opaque ?? (meta !== undefined ? PaymentRequest.serialize(meta) : undefined)
  const id = secretKey
    ? computeId(
        { ...parameters, expires, header, ...(meta !== undefined && { meta }), opaque },
        { secretKey },
      )
    : (parameters as { id: string }).id

  return Schema.parse({
    id,
    realm,
    method: methodName,
    intent,
    request,
    ...(description && { description }),
    ...(digest && { digest }),
    ...(expires && { expires }),
    ...(header !== undefined && { header }),
    ...(meta !== undefined && { meta }),
    ...(opaque !== undefined && { opaque }),
  }) as from.ReturnType<parameters, methods>
}

export declare namespace from {
  type Options<methods extends readonly Method.Method[] | undefined = undefined> = {
    methods?: methods
  }

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
    /** Optional human-readable description of the payment. */
    description?: string | undefined
    /** Optional digest of the request body. */
    digest?: string | undefined
    /** Optional expiration timestamp (ISO 8601). */
    expires?: z.DatetimeInput | undefined
    /**
     * Optional HTTP field name to carry the payment credential: `Payment-Authorization`, or
     * `Authorization` (the default, not advertised). Any other value throws.
     */
    header?: string | undefined
    /** Intent type (e.g., "charge", "session"). */
    intent: string
    /** Optional server-defined correlation data (serialized as `opaque` on the challenge). Flat string-to-string map; clients MUST NOT modify. */
    meta?: Record<string, string> | undefined
    /** Optional raw base64url-encoded server-defined correlation data. Clients MUST NOT modify. */
    opaque?: string | undefined
    /** Payment method (e.g., "tempo", "stripe"). */
    method: string
    /** Server realm (e.g., hostname). */
    realm: string
    /** Method-specific request data. */
    request: PaymentRequest.Request
  }

  type ReturnType<
    parameters extends Parameters,
    methods extends readonly Method.Method[] | undefined = undefined,
  > = methods extends readonly Method.Method[]
    ? FromMethods<methods>
    : Challenge<parameters['request']>
}

/**
 * Creates a validated challenge from a method intent.
 *
 * If `secretKey` option is provided, the challenge ID is computed as HMAC-SHA256
 * over the canonical challenge ID input, cryptographically binding the ID to its contents.
 *
 * @param intent - The method intent to validate against.
 * @param parameters - Challenge parameters (realm, request, optional expires/digest, and id if no secretKey).
 * @param options - Optional settings including secretKey for HMAC-bound ID.
 * @returns A validated challenge.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mppx'
 * import { Methods } from 'mppx/tempo'
 *
 * // With HMAC-bound ID (recommended for servers)
 * const challenge = Challenge.fromMethod(
 *   Methods.charge,
 *   {
 *     realm: 'api.example.com',
 *     expires: '2025-01-06T12:00:00Z',
 *     request: {
 *       amount: '1000000',
 *       currency: '0x20c0000000000000000000000000000000000001',
 *       recipient: '0x742d35Cc6634C0532925a3b844Bc9e7595f8fE00',
 *     },
 *   },
 *   { secretKey: 'my-secret' },
 * )
 * ```
 */
export function fromMethod<const method extends Method.Method>(
  method: method,
  parameters: fromMethod.Parameters<method>,
): fromMethod.ReturnType<method> {
  const { name: methodName, intent } = method
  const { description, digest, expires, header, id, meta, realm, secretKey } = parameters

  const request = PaymentRequest.fromMethod(method, parameters.request)

  return from({
    ...(id !== undefined ? { id } : { secretKey }),
    realm,
    method: methodName,
    intent: intent,
    request,
    description,
    digest,
    expires,
    header,
    meta,
  } as from.Parameters) as fromMethod.ReturnType<method>
}

export declare namespace fromMethod {
  type Parameters<method extends Method.Method> = OneOf<
    | {
        /** Explicit challenge ID. */
        id: string
      }
    | {
        /** Secret key for HMAC-bound challenge ID. */
        secretKey: string
      }
  > & {
    /** Optional human-readable description of the payment. */
    description?: string | undefined
    /** Optional digest of the request body. */
    digest?: string | undefined
    /** Optional expiration timestamp (ISO 8601). */
    expires?: z.DatetimeInput | undefined
    /**
     * Optional HTTP field name to carry the payment credential: `Payment-Authorization`, or
     * `Authorization` (the default, not advertised). Any other value throws.
     */
    header?: string | undefined
    /** Optional server-defined correlation data (serialized as `opaque` on the challenge). Flat string-to-string map; clients MUST NOT modify. */
    meta?: Record<string, string> | undefined
    /** Server realm (e.g., hostname). */
    realm: string
    /** Method-specific request data. */
    request: z.input<method['schema']['request']>
  }

  type ReturnType<method extends Method.Method> = Challenge<z.output<method['schema']['request']>>
}

/**
 * Serializes a challenge to the WWW-Authenticate header format.
 *
 * @param challenge - The challenge to serialize.
 * @returns A string suitable for the WWW-Authenticate header value.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mppx'
 *
 * const header = Challenge.serialize(challenge)
 * // => 'Payment id="abc123", realm="api.example.com", method="tempo", intent="charge", request="eyJhbW91bnQiOi..."'
 * ```
 */
export function serialize(challenge: Challenge): string {
  assertMethod(challenge.method)
  const parts = [
    authParam('id', challenge.id),
    authParam('realm', challenge.realm),
    authParam('method', challenge.method),
    authParam('intent', challenge.intent),
    authParam('request', PaymentRequest.serialize(challenge.request)),
  ]

  if (challenge.description !== undefined)
    parts.push(authParam('description', challenge.description, { escapeUnicode: true }))
  if (challenge.digest !== undefined) parts.push(authParam('digest', challenge.digest))
  if (challenge.expires !== undefined) parts.push(authParam('expires', challenge.expires))
  const credentialHeader = advertisedCredentialHeader(challenge.header)
  if (credentialHeader !== undefined) parts.push(authParam('header', credentialHeader))
  if (challenge.opaque !== undefined) parts.push(authParam('opaque', challenge.opaque))
  else if (challenge.meta !== undefined)
    parts.push(authParam('opaque', PaymentRequest.serialize(challenge.meta)))

  return `${Constants.Schemes.payment} ${parts.join(', ')}`
}

/** Payment method identifier grammar: `1*LOWERALPHA` (a-z only). */
const methodPattern = /^[a-z]+$/

/** @internal Throws unless `method` matches the spec's method identifier grammar (a-z only). */
function assertMethod(method: string): void {
  if (!methodPattern.test(method))
    throw new Error(`Invalid method: "${method}". Must be lowercase letters a-z per spec.`)
}

/** @internal */
function authParam(
  name: string,
  value: string,
  options: { escapeUnicode?: boolean | undefined } = {},
): string {
  if (/[\r\n]/.test(value)) throw new Error('Invalid quoted-string value.')
  const escaped = value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')
  // Header values must be ByteStrings (code points ≤ 0xFF). Receivers read a
  // backslash as quoted-pair (`\\u2014` is the text `u2014`), so other
  // characters cannot round-trip in a quoted-string.
  if (!/[\u0100-\uffff]/.test(escaped)) return `${name}="${escaped}"`
  // The display-only description is not bound into the Challenge ID: keep the
  // `\\uXXXX` escape there so a 402 never fails on an em dash or emoji in a
  // product title. Receivers show the escape text.
  if (options.escapeUnicode)
    return `${name}="${escaped.replace(/[\u0100-\uffff]/g, (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, '0')}`)}"`
  throw new Error(`Invalid ${name}: characters above U+00FF cannot be sent in a header.`)
}

/**
 * Deserializes a WWW-Authenticate header value to a challenge.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mppx'
 *
 * const challenge = Challenge.deserialize(header)
 *
 * // With methods for type narrowing
 * const challenge = Challenge.deserialize(header, { methods })
 * ```
 *
 * @param header - The WWW-Authenticate header value.
 * @param options - Optional settings to narrow the challenge type.
 * @returns The deserialized challenge.
 */
export function deserialize<const methods extends readonly Method.Method[] | undefined = undefined>(
  value: string,
  options?: from.Options<methods>,
): from.ReturnType<from.Parameters, methods> {
  const params = extractPaymentAuthParams(value)
  if (!params) throw new Error('Missing Payment scheme.')

  const result = parseAuthParams(params)

  const { request, opaque, header, ...rest } = result
  if (!request) throw new Error('Missing request parameter.')
  if (request.length > maxRequestParameterLength) throw new Error('Request parameter too large.')
  if (rest.method !== undefined) assertMethod(rest.method)
  // Validate the raw value before `from` treats `Authorization` as the omitted default: a
  // received challenge may only select `Payment-Authorization`.
  if (header !== undefined && !isPaymentAuthorizationHeader(header))
    throw new UnsupportedCredentialHeaderError()

  const challenge = from(
    {
      ...rest,
      request: PaymentRequest.deserialize(request),
      ...(opaque && { opaque }),
    } as from.Parameters,
    options,
  )
  // Keep the spelling the server sent: the client echoes it unchanged, and the server's challenge
  // ID may bind that exact spelling.
  if (header === undefined) return challenge
  return { ...challenge, header } as from.ReturnType<from.Parameters, methods>
}

/** @internal Extracts the `Payment` scheme from a WWW-Authenticate value that may contain multiple schemes. */
function extractPaymentAuthParams(header: string): string | null {
  const token = Constants.Schemes.payment
  const [start] = findSchemeStarts(header, token)
  if (start === undefined) return null

  let paramsStart = start + token.length
  while (paramsStart < header.length && /\s/.test(header[paramsStart] ?? '')) paramsStart++
  return header.slice(paramsStart)
}

/** @internal Parses auth-params with support for escaped quoted-string values. */
function parseAuthParams(input: string): Record<string, string> {
  const result: Record<string, string> = Object.create(null)
  let i = 0

  while (i < input.length) {
    while (i < input.length && /[\s,]/.test(input[i] ?? '')) i++
    if (i >= input.length) break

    const keyStart = i
    while (i < input.length && /[A-Za-z0-9_-]/.test(input[i] ?? '')) i++
    const key = input.slice(keyStart, i).toLowerCase()
    if (!key) throw new Error('Malformed auth-param.')

    while (i < input.length && /\s/.test(input[i] ?? '')) i++

    // If there is no '=' after a token, this is likely another auth scheme.
    if (input[i] !== '=') break
    i++

    while (i < input.length && /\s/.test(input[i] ?? '')) i++

    const [value, nextIndex] = readAuthParamValue(input, i)
    i = nextIndex

    if (key in result) throw new Error(`Duplicate parameter: ${key}`)
    result[key] = value
  }

  return result
}

/** @internal */
function readAuthParamValue(input: string, start: number): [value: string, nextIndex: number] {
  if (input[start] === '"') return readQuotedAuthParamValue(input, start + 1)

  let i = start
  while (i < input.length && input[i] !== ',') i++
  return [input.slice(start, i).trim(), i]
}

/** @internal */
function readQuotedAuthParamValue(
  input: string,
  start: number,
): [value: string, nextIndex: number] {
  let i = start
  let escaped = false
  let segmentStart = start
  let parts: string[] | undefined

  while (i < input.length) {
    const char = input[i]!
    i++

    if (escaped) {
      // quoted-pair (RFC 9110): drop the backslash and keep the next character
      // as is, so `\\u2014` is the text `u2014`, not an escape.
      parts ??= []
      parts.push(char)
      segmentStart = i
      escaped = false
      continue
    }

    if (char === '\\') {
      parts ??= []
      parts.push(input.slice(segmentStart, i - 1))
      segmentStart = i
      escaped = true
      continue
    }

    if (char === '"') {
      const value = parts
        ? [...parts, input.slice(segmentStart, i - 1)].join('')
        : input.slice(start, i - 1)
      return [value, i]
    }
  }

  throw new Error('Unterminated quoted-string.')
}

/** @internal */
function startsWithSchemeToken(value: string, index: number, token: string): boolean {
  if (value.slice(index, index + token.length).toLowerCase() !== token.toLowerCase()) return false
  const next = value[index + token.length]
  return Boolean(next && /\s/.test(next))
}

/**
 * Returns whether a `WWW-Authenticate` value contains a Payment challenge.
 *
 * @internal
 */
export function hasPaymentScheme(value: string): boolean {
  // A bare `Payment` scheme with no parameters is still a (malformed) Payment challenge.
  return (
    findSchemeStarts(value, Constants.Schemes.payment).length > 0 ||
    value
      .split(',')
      .some((part) => part.trim().toLowerCase() === Constants.Schemes.payment.toLowerCase())
  )
}

/** @internal Finds auth scheme boundaries while ignoring quoted-string contents. */
function findSchemeStarts(value: string, token: string): number[] {
  const starts: number[] = []
  let inQuotes = false
  let escaped = false

  for (let i = 0; i < value.length; i++) {
    const char = value[i]

    if (inQuotes) {
      if (escaped) escaped = false
      else if (char === '\\') escaped = true
      else if (char === '"') inQuotes = false
      continue
    }

    if (char === '"') {
      inQuotes = true
      continue
    }

    if (!startsWithSchemeToken(value, i, token)) continue

    let boundary = i - 1
    while (boundary >= 0 && /\s/.test(value[boundary] ?? '')) boundary--
    if (boundary >= 0 && value[boundary] !== ',') continue
    starts.push(i)
  }

  return starts
}

/**
 * Extracts the challenge from a Headers object.
 *
 * @param headers - The HTTP headers.
 * @param options - Optional settings to narrow the challenge type.
 * @returns The deserialized challenge.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mppx'
 *
 * const challenge = Challenge.fromHeaders(response.headers)
 *
 * // With methods for type narrowing
 * const challenge = Challenge.fromHeaders(response.headers, { methods })
 * ```
 */
export function fromHeaders<const methods extends readonly Method.Method[] | undefined = undefined>(
  headers: Headers,
  options?: from.Options<methods>,
): from.ReturnType<from.Parameters, methods> {
  const header = headers.get(Constants.Headers.wwwAuthenticate)
  if (!header) throw new Error(`Missing ${Constants.Headers.wwwAuthenticate} header.`)
  return deserialize(header, options)
}

/**
 * Extracts the challenge from a Response's WWW-Authenticate header.
 *
 * @param response - The HTTP response (must be 402 status).
 * @param options - Optional settings to narrow the challenge type.
 * @returns The deserialized challenge.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mppx'
 *
 * const response = await fetch('/resource')
 * if (response.status === 402)
 *   const challenge = Challenge.fromResponse(response)
 *
 * // With methods for type narrowing
 * const challenge = Challenge.fromResponse(response, { methods })
 * ```
 */
export function fromResponse<
  const methods extends readonly Method.Method[] | undefined = undefined,
>(response: Response, options?: from.Options<methods>): from.ReturnType<from.Parameters, methods> {
  if (response.status !== 402) throw new Error('Response status is not 402.')
  return fromHeaders(response.headers, options)
}

/**
 * Extracts all Payment challenges from a Response with potentially merged
 * `WWW-Authenticate` headers (multiple challenges in a single header value).
 *
 * @param response - The HTTP response (must be 402 status).
 * @param options - Optional settings to narrow the challenge type.
 * @returns An array of deserialized challenges.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mppx'
 *
 * const response = await fetch('/resource')
 * if (response.status === 402) {
 *   const challenges = Challenge.fromResponseList(response)
 *   // challenges[0] => tempo/charge, challenges[1] => stripe/charge
 * }
 * ```
 */
export function fromResponseList<
  const methods extends readonly Method.Method[] | undefined = undefined,
>(
  response: Response,
  options?: from.Options<methods>,
): from.ReturnType<from.Parameters, methods>[] {
  if (response.status !== 402) throw new Error('Response status is not 402.')
  return fromHeadersList(response.headers, options)
}

/**
 * Extracts all Payment challenges from a Headers object with potentially
 * merged `WWW-Authenticate` values.
 *
 * @param headers - The HTTP headers.
 * @param options - Optional settings to narrow the challenge type.
 * @returns An array of deserialized challenges.
 */
export function fromHeadersList<
  const methods extends readonly Method.Method[] | undefined = undefined,
>(headers: Headers, options?: from.Options<methods>): from.ReturnType<from.Parameters, methods>[] {
  const header = headers.get(Constants.Headers.wwwAuthenticate)
  if (!header) throw new Error(`Missing ${Constants.Headers.wwwAuthenticate} header.`)
  return deserializeList(header, options)
}

/**
 * Deserializes a `WWW-Authenticate` header value that may contain multiple
 * Payment challenges (comma-separated per RFC 9110 §11.6.1).
 *
 * Challenges that select a credential header other than `Payment-Authorization`
 * are skipped, so the result may be empty.
 *
 * @param value - The raw WWW-Authenticate header value.
 * @param options - Optional settings to narrow the challenge type.
 * @returns An array of deserialized challenges.
 */
export function deserializeList<
  const methods extends readonly Method.Method[] | undefined = undefined,
>(value: string, options?: from.Options<methods>): from.ReturnType<from.Parameters, methods>[] {
  const chunks = paymentChunks(value)
  if (chunks.length === 0) throw new Error('No Payment schemes found.')

  return chunks.flatMap((chunk) => {
    try {
      return [deserialize(chunk, options)]
    } catch (error) {
      // A challenge with an unsupported credential header gets no credential,
      // but must not stop the client from paying another challenge.
      if (error instanceof UnsupportedCredentialHeaderError) return []
      throw error
    }
  })
}

/**
 * Counts the Payment challenges in a `WWW-Authenticate` value that list parsing skips because they
 * select a credential header other than `Payment-Authorization`.
 *
 * @internal
 */
export function countUnsupportedCredentialHeaders(value: string | null | undefined): number {
  if (!value) return 0
  return paymentChunks(value).filter((chunk) => {
    try {
      deserialize(chunk)
      return false
    } catch (error) {
      return error instanceof UnsupportedCredentialHeaderError
    }
  }).length
}

/**
 * Appends a note on skipped challenges to an error that reports no payable challenge. Returns the
 * message unchanged when none were skipped.
 *
 * @internal
 */
export function withSkippedChallenges(message: string, count: number): string {
  if (count <= 0) return message
  return count === 1
    ? `${message}. Skipped 1 challenge that selects a credential header other than Payment-Authorization`
    : `${message}. Skipped ${count} challenges that select a credential header other than Payment-Authorization`
}

/** Splits a `WWW-Authenticate` value into its `Payment` challenges. */
function paymentChunks(value: string): string[] {
  const starts = findSchemeStarts(value, Constants.Schemes.payment)
  // Slice each scheme from its `Payment ` prefix up to the next scheme boundary,
  // trimming any trailing comma/whitespace between schemes.
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]! : value.length
    return value.slice(start, end).replace(/,\s*$/, '')
  })
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
 * import { Challenge } from 'mppx'
 *
 * const isValid = Challenge.verify(challenge, { secretKey: 'my-secret' })
 * ```
 */
export function verify(challenge: Challenge, options: verify.Options): boolean {
  let expectedId: string
  try {
    expectedId = computeId(challenge, options)
  } catch (error) {
    // A challenge that selects an unsupported credential header was never issued by this server.
    if (error instanceof UnsupportedCredentialHeaderError) return false
    throw error
  }
  return constantTimeEqual(challenge.id, expectedId)
}

export declare namespace verify {
  type Options = {
    /** Secret key for HMAC-bound challenge ID verification. */
    secretKey: string
  }
}

/** Extracts parsed server-defined correlation data from a challenge when available. */
export function meta(challenge: Challenge): Record<string, string> | undefined {
  return challenge.meta
}

/**
 * Canonical HMAC input for challenge ID binding per §5.1.2.1.1 of the spec.
 *
 * Seven fixed positional slots, pipe-delimited. Optional fields use empty
 * string when absent so the slot count is stable. This is the single source
 * of truth for what the challenge ID binds to — used by both `computeId()`
 * (challenge creation) and `verify()` (credential verification).
 *
 * Legacy slots: realm | method | intent | request | expires | digest | opaque.
 * Challenges advertising a credential header insert it immediately before the
 * final opaque slot.
 *
 * Because the HMAC covers ALL fields, the server does not need to separately
 * pin opaque, digest, or expires during verification — any change to those
 * fields produces a different HMAC and fails the ID comparison.
 */
function idBindingInput(challenge: Omit<Challenge, 'id'>): string {
  const values = [
    challenge.realm,
    challenge.method,
    challenge.intent,
    PaymentRequest.serialize(challenge.request),
    challenge.expires ?? '',
    challenge.digest ?? '',
  ]
  // Keep opaque in the final optional slot required by the Payment auth scheme.
  const credentialHeader = advertisedCredentialHeader(challenge.header)
  if (credentialHeader !== undefined) values.push(credentialHeader)
  values.push(challenge.opaque ?? (challenge.meta ? PaymentRequest.serialize(challenge.meta) : ''))
  return values.join('|')
}

/**
 * Returns the HTTP field name a client must use for a payment credential: `Authorization` when the
 * challenge omits `header`, and the canonical `Payment-Authorization` for any spelling of it.
 */
export function credentialHeader(challenge: Challenge): string {
  const { header } = challenge
  if (header === undefined) return Constants.Headers.authorization
  return isPaymentAuthorizationHeader(header) ? Constants.Headers.paymentAuthorization : header
}

/**
 * Returns whether a challenge object selects a credential header a client must not send a Payment
 * credential for: any `header` other than `Payment-Authorization` (matched case-insensitively).
 *
 * Use it on challenge objects received outside `WWW-Authenticate`, such as MCP payment-required
 * data, to skip such a challenge while still paying another one.
 *
 * @internal
 */
export function hasUnsupportedCredentialHeader(challenge: unknown): boolean {
  if (typeof challenge !== 'object' || challenge === null || !('header' in challenge)) return false
  const { header } = challenge as { header: unknown }
  return (
    header !== undefined && !(typeof header === 'string' && isPaymentAuthorizationHeader(header))
  )
}

/** Returns whether a header name is `Payment-Authorization`, ignoring ASCII case. */
function isPaymentAuthorizationHeader(header: string): boolean {
  // Without the `u` flag, `i` folds ASCII letters only.
  return /^payment-authorization$/i.test(header)
}

/**
 * Normalizes a locally configured credential header: `Authorization` (any case) is the
 * implicit default and is not advertised, `Payment-Authorization` is canonicalized, and any
 * other value throws because servers MUST NOT emit it.
 */
function normalizeCredentialHeader(header: string | undefined): string | undefined {
  const advertised = advertisedCredentialHeader(header)
  return advertised === undefined ? undefined : Constants.Headers.paymentAuthorization
}

/**
 * Returns a challenge's `header` as it is advertised and bound into the challenge ID:
 * `Authorization` (any case) is the implicit default and is omitted, a `Payment-Authorization`
 * spelling is kept exactly as given, and any other value throws because servers MUST NOT emit it.
 */
function advertisedCredentialHeader(header: string | undefined): string | undefined {
  if (header === undefined) return undefined
  if (/^authorization$/i.test(header)) return undefined
  if (isPaymentAuthorizationHeader(header)) return header
  throw new UnsupportedCredentialHeaderError()
}

/** @internal Computes HMAC-SHA256 challenge ID from parameters. */
function computeId(challenge: Omit<Challenge, 'id'>, options: { secretKey: string }): string {
  // Each field occupies a fixed positional slot joined by '|'. Optional fields
  // use an empty string when absent so the slot count is stable — this avoids
  // ambiguity between e.g. (expires set, no digest) vs (no expires, digest set)
  // and means adding a new optional field changes all HMACs exactly once.
  const input = idBindingInput(challenge)

  const key = Bytes.fromString(options.secretKey)
  const data = Bytes.fromString(input)
  const mac = Hash.hmac256(key, data, { as: 'Bytes' })
  return Base64.fromBytes(mac, { url: true, pad: false })
}
