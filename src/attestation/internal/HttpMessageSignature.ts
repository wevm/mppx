import {
  isInnerList,
  parseDictionary,
  serializeItem,
  serializeDictionary,
  serializeInnerList,
  serializeParameters,
} from 'structured-headers'
import type { BareItem, Dictionary, InnerList, Item } from 'structured-headers'

import type { MaybePromise } from '../../internal/types.js'
import { Algorithms, Headers as AttestationHeaders } from '../Constants.js'
import type * as NonceStore from '../NonceStore.js'
import type { KeyResolver, SignatureAlgorithm, SigningContext } from '../Types.js'
import * as SigningContextInternal from './SigningContext.js'

/** RFC 9421 constants used by request-attestation signature profiles. */
export const Constants = {
  /** Derived request components supported by this narrow request profile. */
  components: {
    /** The target host and non-default port. */
    authority: '@authority',
    /** The case-sensitive HTTP request method. */
    method: '@method',
    /** The request URL path without its query string. */
    path: '@path',
    /** The lowercased `Signature-Agent` request header. */
    signatureAgent: 'signature-agent',
    /** The signature's canonicalized covered-components and parameters. */
    signatureParams: '@signature-params',
  },
  /** RFC 9421 algorithm identifiers supported by request attestation. */
  algorithms: Algorithms,
} as const

/** A covered HTTP message component and its RFC 9421 component parameters. */
export type Component = {
  /** Derived component identifier or lowercased HTTP field name. */
  id: string
  /** Parameters that qualify the component, such as `;key="agent"`. */
  parameters?: ReadonlyMap<string, BareItem> | undefined
}

/** Input accepted by signers; bare strings denote unparameterized components. */
export type ComponentInput = string | Component

export type SignatureInput = {
  algorithm: SignatureAlgorithm
  components: readonly Component[]
  created: number
  expires: number
  keyId: string
  label: string
  nonce: string
  parameters: ReadonlyMap<string, BareItem>
  tag: string
}

/** Result of validating one supported RFC 9421 signature. */
export type VerificationResult =
  | { status: 'absent' }
  | { status: 'invalid'; reason: string }
  | { status: 'unverified'; reason: string }
  | { status: 'verified'; input: SignatureInput }

/** Signs a request using the configured RFC 9421-derived component list. */
export async function sign(
  request: Request,
  options: {
    components: readonly ComponentInput[]
    expiresIn?: number | undefined
    keyId: string
    key: CryptoKey
    label: string
    context?: SigningContext | undefined
    tag: string
  },
): Promise<Request> {
  const context = options.context ?? SigningContextInternal.create()
  const created = context.created
  const expires = created + (options.expiresIn ?? 60)
  const algorithm = algorithmFromKey(options.key)
  const parameters = new Map<string, BareItem>([
    ['created', created],
    ['expires', expires],
    ['keyid', options.keyId],
    ['alg', algorithm],
    ['nonce', context.nonce],
    ['tag', options.tag],
  ])
  const input: SignatureInput = {
    algorithm,
    components: options.components.map(toComponent),
    created,
    expires,
    keyId: options.keyId,
    label: options.label,
    nonce: context.nonce,
    parameters,
    tag: options.tag,
  }
  const signature = await crypto.subtle.sign(
    webCryptoAlgorithm(algorithm),
    options.key,
    toArrayBuffer(encode(signatureBase(request, input))),
  )
  const headers = new Headers(request.headers)
  const inputs = parseHeaderDictionary(headers, AttestationHeaders.signatureInput)
  const signatures = parseHeaderDictionary(headers, AttestationHeaders.signature)
  if (!haveSameKeys(inputs, signatures))
    throw new Error('Signature-Input and Signature must contain the same labels.')
  if (inputs.has(input.label) || signatures.has(input.label))
    throw new Error(`HTTP message signature label "${input.label}" already exists.`)
  inputs.set(input.label, toInnerList(input))
  signatures.set(input.label, [signature, new Map()])
  headers.set(AttestationHeaders.signatureInput, serializeDictionary(inputs))
  headers.set(AttestationHeaders.signature, serializeDictionary(signatures))
  return new Request(request, { headers })
}

/** Verifies a request signature, its lifetime, and optionally its nonce. */
export async function verify(
  request: Request,
  options: {
    keyResolver: KeyResolver
    maxAge: number
    nonceNamespace: string
    nonceStore: NonceStore.Store
    requiredComponents: readonly string[]
    tag: string | readonly string[]
    validate?: ((input: SignatureInput, request: Request) => string | undefined) | undefined
    validateKey?:
      | ((
          key: CryptoKey,
          input: SignatureInput,
          request: Request,
        ) => MaybePromise<string | undefined>)
      | undefined
  },
): Promise<VerificationResult> {
  const parsed = parse(request, options.tag)
  if (!parsed) return { status: 'absent' }
  if (parsed.reason) return { status: 'invalid', reason: parsed.reason }
  if (!parsed.input || !parsed.signature)
    return { status: 'invalid', reason: 'The HTTP message signature is malformed.' }
  const { input, signature } = parsed

  if (!options.requiredComponents.every((component) => hasComponent(input.components, component)))
    return {
      status: 'invalid',
      reason: 'The signature does not cover the required request components.',
    }
  const now = Math.floor(Date.now() / 1000)
  if (input.created > now || input.expires <= now || input.expires - input.created > options.maxAge)
    return { status: 'invalid', reason: 'The signature is expired or has an invalid lifetime.' }
  if (options.validate) {
    const reason = options.validate(input, request)
    if (reason) return { status: 'invalid', reason }
  }
  let key: CryptoKey | undefined
  try {
    key = await options.keyResolver({
      algorithm: input.algorithm,
      keyId: input.keyId,
      request,
    })
  } catch {
    return { status: 'unverified', reason: 'The public key could not be resolved.' }
  }
  if (!key)
    return {
      status: 'unverified',
      reason: 'No public key is available for the signature key ID.',
    }
  if (!keySupportsAlgorithm(key, input.algorithm))
    return {
      status: 'invalid',
      reason: 'The public key does not support the signature algorithm.',
    }
  if (options.validateKey) {
    const reason = await options.validateKey(key, input, request)
    if (reason) return { status: 'invalid', reason }
  }
  let valid: boolean
  try {
    valid = await crypto.subtle.verify(
      webCryptoAlgorithm(input.algorithm),
      key,
      toArrayBuffer(signature),
      toArrayBuffer(encode(signatureBase(request, input))),
    )
  } catch {
    valid = false
  }
  if (!valid) return { status: 'invalid', reason: 'The HTTP message signature is invalid.' }
  try {
    if (
      await options.nonceStore.consume(
        `${options.nonceNamespace}:${input.keyId}:${input.nonce}`,
        input.expires * 1000,
      )
    )
      return { status: 'invalid', reason: 'The signature nonce has already been used.' }
  } catch {
    return { status: 'unverified', reason: 'Replay protection is unavailable.' }
  }
  return { status: 'verified', input }
}

function parse(
  request: Request,
  expectedTag: string | readonly string[],
): { input?: SignatureInput; reason?: string; signature?: Uint8Array } | undefined {
  const inputHeader = request.headers.get(AttestationHeaders.signatureInput)
  const signatureHeader = request.headers.get(AttestationHeaders.signature)
  if (!inputHeader && !signatureHeader) return undefined
  if (!inputHeader || !signatureHeader)
    return { reason: 'Signature-Input and Signature must both be provided.' }
  let inputs: Dictionary
  let signatures: Dictionary
  try {
    inputs = parseDictionary(inputHeader)
    signatures = parseDictionary(signatureHeader)
  } catch {
    return { reason: 'The HTTP message signature is malformed.' }
  }
  if (!haveSameKeys(inputs, signatures))
    return { reason: 'Signature-Input and Signature do not contain the same labels.' }
  const tags = new Set(typeof expectedTag === 'string' ? [expectedTag] : expectedTag)
  for (const [label, entry] of inputs) {
    if (!hasExpectedTag(entry, tags)) continue
    const input = toSignatureInput(label, entry)
    if (!input) return { reason: 'The HTTP message signature is malformed.' }
    const signature = signatures.get(label)
    if (!signature || isInnerList(signature) || !(signature[0] instanceof ArrayBuffer))
      return { reason: 'No matching HTTP message signature was provided.' }
    return { input, signature: new Uint8Array(signature[0]) }
  }
  return undefined
}

function serializeInput(input: SignatureInput): string {
  return serializeInnerList(toInnerList(input))
}

function toInnerList(input: SignatureInput): InnerList {
  const components: InnerList[0] = input.components.map((component) => [
    component.id,
    new Map(component.parameters),
  ])
  return [components, new Map(input.parameters)]
}

function toSignatureInput(label: string, entry: unknown): SignatureInput | undefined {
  const innerList = entry as InnerList
  if (!isInnerList(innerList)) return undefined
  const [componentEntries, parameters] = innerList
  if (
    !componentEntries.length ||
    !componentEntries.every(([component]) => typeof component === 'string')
  )
    return undefined
  const components = componentEntries.map(([id, parameters]) => ({
    id: id as string,
    parameters,
  }))
  const created = parameters.get('created')
  const expires = parameters.get('expires')
  const algorithm = parameters.get('alg')
  const keyId = parameters.get('keyid')
  const nonce = parameters.get('nonce')
  const tag = parameters.get('tag')
  if (
    typeof created !== 'number' ||
    !Number.isInteger(created) ||
    typeof expires !== 'number' ||
    !Number.isInteger(expires) ||
    !isSignatureAlgorithm(algorithm) ||
    typeof keyId !== 'string' ||
    typeof nonce !== 'string' ||
    typeof tag !== 'string'
  )
    return undefined
  return {
    algorithm,
    components,
    created,
    expires,
    keyId,
    label,
    nonce,
    parameters,
    tag,
  }
}

function algorithmFromKey(key: CryptoKey): SignatureAlgorithm {
  if (key.algorithm.name === 'Ed25519') return Algorithms.ed25519
  if (
    key.algorithm.name === 'RSA-PSS' &&
    (key.algorithm as RsaHashedKeyAlgorithm).hash.name === 'SHA-512'
  )
    return Algorithms.rsaPssSha512
  throw new TypeError('Request attestation requires an Ed25519 or RSA-PSS SHA-512 signing key.')
}

function isSignatureAlgorithm(value: unknown): value is SignatureAlgorithm {
  return value === Algorithms.ed25519 || value === Algorithms.rsaPssSha512
}

function keySupportsAlgorithm(key: CryptoKey, algorithm: SignatureAlgorithm): boolean {
  if (algorithm === Algorithms.ed25519) return key.algorithm.name === 'Ed25519'
  return (
    key.algorithm.name === 'RSA-PSS' &&
    (key.algorithm as RsaHashedKeyAlgorithm).hash.name === 'SHA-512'
  )
}

function webCryptoAlgorithm(algorithm: SignatureAlgorithm): AlgorithmIdentifier | RsaPssParams {
  return algorithm === Algorithms.ed25519 ? 'Ed25519' : { name: 'RSA-PSS', saltLength: 64 }
}

function signatureBase(request: Request, input: SignatureInput): string {
  const lines = input.components.map(
    (component) => `${serializeComponent(component)}: ${componentValue(request, component)}`,
  )
  lines.push(`"${Constants.components.signatureParams}": ${serializeInput(input)}`)
  return lines.join('\n')
}

function componentValue(request: Request, component: Component): string {
  const url = new URL(request.url)
  if (component.id === Constants.components.authority) {
    if (component.parameters?.size) throw new Error('Unsupported parameters for "@authority".')
    return url.host
  }
  if (component.id === Constants.components.path) {
    if (component.parameters?.size) throw new Error('Unsupported parameters for "@path".')
    return url.pathname
  }
  if (component.id === Constants.components.method) {
    if (component.parameters?.size) throw new Error('Unsupported parameters for "@method".')
    return request.method
  }
  if (component.parameters?.size)
    return componentDictionaryValue(request, component.id, component.parameters)
  const value = request.headers.get(component.id)
  if (value === null) throw new Error(`Missing signed HTTP header "${component.id}".`)
  if (!/^[\x20-\x7e]*$/.test(value))
    throw new Error(`Signed HTTP header "${component.id}" is not ASCII.`)
  return value
}

function componentDictionaryValue(
  request: Request,
  component: string,
  parameters: ReadonlyMap<string, BareItem>,
): string {
  const key = parameters.get('key')
  if (typeof key !== 'string' || parameters.size !== 1)
    throw new Error(`Unsupported parameters for signed HTTP header "${component}".`)
  const value = request.headers.get(component)
  if (value === null) throw new Error(`Missing signed HTTP header "${component}".`)
  let dictionary: Dictionary
  try {
    dictionary = parseDictionary(value)
  } catch {
    throw new Error(`Signed HTTP header "${component}" is not a structured dictionary.`)
  }
  const member = dictionary.get(key)
  if (!member || isInnerList(member))
    throw new Error(`Signed HTTP header "${component}" has no member "${key}".`)
  return serializeItem(member)
}

function hasComponent(components: readonly Component[], expected: string): boolean {
  return components.some((component) => component.id === expected)
}

function haveSameKeys(left: Dictionary, right: Dictionary): boolean {
  return left.size === right.size && [...left.keys()].every((key) => right.has(key))
}

function hasExpectedTag(entry: unknown, tags: ReadonlySet<string>): boolean {
  const value = entry as Item | InnerList
  if (!isInnerList(value)) return false
  const tag = value[1].get('tag')
  return typeof tag === 'string' && tags.has(tag)
}

function serializeComponent(component: Component): string {
  return `"${component.id}"${component.parameters?.size ? serializeParameters(new Map(component.parameters)) : ''}`
}

function toComponent(component: ComponentInput): Component {
  return typeof component === 'string'
    ? { id: component }
    : { id: component.id, parameters: component.parameters && new Map(component.parameters) }
}

function parseHeaderDictionary(headers: Headers, name: string): Dictionary {
  const value = headers.get(name)
  if (!value) return new Map()
  try {
    return parseDictionary(value)
  } catch {
    throw new Error(`HTTP header "${name}" is not a structured dictionary.`)
  }
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer
}
