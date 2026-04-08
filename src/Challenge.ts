import { Base64, Bytes, Hash } from 'ox'

import { constantTimeEqual } from './internal/constantTimeEqual.js'
import type { OneOf } from './internal/types.js'
import type * as Method from './Method.js'
import * as PaymentRequest from './PaymentRequest.js'
import * as z from './zod.js'

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
  /** Unique challenge identifier (HMAC-bound). */
  id: z.string(),
  /** Intent type (e.g., "charge", "session"). */
  intent: z.string(),
  /** Payment method (e.g., "tempo", "stripe"). */
  method: z.string(),
  /** Optional server-defined correlation data. Flat string-to-string map; clients MUST NOT modify. */
  opaque: z.optional(z.record(z.string(), z.string())),
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
 * over the canonical challenge binding input
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
    intent,
    realm,
    request,
    secretKey,
  } = parameters

  const expires = parameters.expires as string
  const id = secretKey
    ? computeId({ ...parameters, expires, ...(meta && { opaque: meta }) }, { secretKey })
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
    ...(meta && { opaque: meta }),
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
    expires?: string | undefined
    /** Intent type (e.g., "charge", "session"). */
    intent: string
    /** Optional server-defined correlation data (serialized as `opaque` on the challenge). Flat string-to-string map; clients MUST NOT modify. */
    meta?: Record<string, string> | undefined
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
 * over the canonical challenge binding input, cryptographically binding the ID to its contents.
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
  const { description, digest, expires, id, meta, realm, secretKey } = parameters

  const request = PaymentRequest.fromMethod(method, parameters.request)

  return from({
    ...(id ? { id } : { secretKey }),
    realm,
    method: methodName,
    intent: intent,
    request,
    description,
    digest,
    expires,
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
    expires?: string | undefined
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
  const parts = [
    `id="${challenge.id}"`,
    `realm="${challenge.realm}"`,
    `method="${challenge.method}"`,
    `intent="${challenge.intent}"`,
    `request="${PaymentRequest.serialize(challenge.request)}"`,
  ]

  if (challenge.description !== undefined) parts.push(`description="${challenge.description}"`)
  if (challenge.digest !== undefined) parts.push(`digest="${challenge.digest}"`)
  if (challenge.expires !== undefined) parts.push(`expires="${challenge.expires}"`)
  if (challenge.opaque !== undefined)
    parts.push(`opaque="${PaymentRequest.serialize(challenge.opaque)}"`)

  return `Payment ${parts.join(', ')}`
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

  const { request, opaque, ...rest } = result
  if (!request) throw new Error('Missing request parameter.')
  if (rest.method && !/^[a-z][a-z0-9:_-]*$/.test(rest.method))
    throw new Error(`Invalid method: "${rest.method}". Must be lowercase per spec.`)

  return from(
    {
      ...rest,
      request: PaymentRequest.deserialize(request),
      ...(opaque && { meta: PaymentRequest.deserialize(opaque) as Record<string, string> }),
    } as from.Parameters,
    options,
  )
}

/** @internal Extracts the `Payment` scheme from a WWW-Authenticate value that may contain multiple schemes. */
function extractPaymentAuthParams(header: string): string | null {
  const token = 'Payment'
  let inQuotes = false
  let escaped = false

  for (let i = 0; i < header.length; i++) {
    const char = header[i]

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

    if (!startsWithSchemeToken(header, i, token)) continue

    const prefix = header.slice(0, i)
    if (prefix.trim() && !prefix.trimEnd().endsWith(',')) continue

    let paramsStart = i + token.length
    while (paramsStart < header.length && /\s/.test(header[paramsStart] ?? '')) paramsStart++
    return header.slice(paramsStart)
  }

  return null
}

/** @internal Parses auth-params with support for escaped quoted-string values. */
function parseAuthParams(input: string): Record<string, string> {
  const result: Record<string, string> = {}
  let i = 0

  while (i < input.length) {
    while (i < input.length && /[\s,]/.test(input[i] ?? '')) i++
    if (i >= input.length) break

    const keyStart = i
    while (i < input.length && /[A-Za-z0-9_-]/.test(input[i] ?? '')) i++
    const key = input.slice(keyStart, i)
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
  let value = ''
  let escaped = false

  while (i < input.length) {
    const char = input[i]!
    i++

    if (escaped) {
      value += char
      escaped = false
      continue
    }

    if (char === '\\') {
      escaped = true
      continue
    }

    if (char === '"') return [value, i]
    value += char
  }

  throw new Error('Unterminated quoted-string.')
}

/** @internal */
function startsWithSchemeToken(value: string, index: number, token: string): boolean {
  if (!value.slice(index).toLowerCase().startsWith(token.toLowerCase())) return false
  const next = value[index + token.length]
  return Boolean(next && /\s/.test(next))
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
  const header = headers.get('WWW-Authenticate')
  if (!header) throw new Error('Missing WWW-Authenticate header.')
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
  const header = headers.get('WWW-Authenticate')
  if (!header) throw new Error('Missing WWW-Authenticate header.')
  return deserializeList(header, options)
}

/**
 * Deserializes a `WWW-Authenticate` header value that may contain multiple
 * Payment challenges (comma-separated per RFC 9110 §11.6.1).
 *
 * @param value - The raw WWW-Authenticate header value.
 * @param options - Optional settings to narrow the challenge type.
 * @returns An array of deserialized challenges.
 */
export function deserializeList<
  const methods extends readonly Method.Method[] | undefined = undefined,
>(value: string, options?: from.Options<methods>): from.ReturnType<from.Parameters, methods>[] {
  // Find the start index of each `Payment ` scheme prefix.
  const starts: number[] = []
  for (const match of value.matchAll(/Payment\s+/gi)) {
    starts.push(match.index!)
  }
  if (starts.length === 0) throw new Error('No Payment schemes found.')

  // Slice each scheme from its `Payment ` prefix up to the next scheme boundary,
  // trimming any trailing comma/whitespace between schemes.
  return starts.map((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]! : value.length
    const chunk = value.slice(start, end).replace(/,\s*$/, '')
    return deserialize(chunk, options)
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
  const expectedId = computeId(challenge, options)
  return constantTimeEqual(challenge.id, expectedId)
}

export declare namespace verify {
  type Options = {
    /** Secret key for HMAC-bound challenge ID verification. */
    secretKey: string
  }
}

/** Alias for `challenge.opaque`. Extracts server-defined correlation data from a challenge. */
export function meta(challenge: Challenge): Record<string, string> | undefined {
  return challenge.opaque
}

const idBindingFields = [
  'realm',
  'method',
  'intent',
  'request',
  'expires',
  'digest',
  'opaque',
] as const

function idBindingSegments(
  challenge: Omit<Challenge, 'id'>,
): Record<(typeof idBindingFields)[number], string> {
  return {
    realm: challenge.realm,
    method: challenge.method,
    intent: challenge.intent,
    request: PaymentRequest.serialize(challenge.request),
    expires: challenge.expires ?? '',
    digest: challenge.digest ?? '',
    opaque: challenge.opaque ? PaymentRequest.serialize(challenge.opaque) : '',
  }
}

function idBindingInput(challenge: Omit<Challenge, 'id'>): string {
  const segments = idBindingSegments(challenge)
  return idBindingFields.map((field) => segments[field]).join('|')
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
