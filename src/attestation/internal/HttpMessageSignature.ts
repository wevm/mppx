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
import { Headers as AttestationHeaders } from '../Constants.js'
import type { SigningContext } from '../Types.js'
import * as SigningContextInternal from './SigningContext.js'

/** RFC 9421 constants used by the supported Ed25519 request-signature profile. */
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
  /** RFC 9421 algorithm identifier for Ed25519 signatures. */
  algorithms: {
    /** The Ed25519 algorithm name registered by RFC 9421. */
    ed25519: 'ed25519',
  },
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
  algorithm: typeof Constants.algorithms.ed25519
  components: readonly Component[]
  created: number
  expires: number
  keyId: string
  label: string
  nonce: string
  parameters: ReadonlyMap<string, BareItem>
  tag: string
}

export type KeyResolver = (parameters: {
  keyId: string
  request: Request
}) => MaybePromise<CryptoKey | undefined>

export type NonceStore = {
  /** Atomically records a nonce and returns `true` when it was previously used. */
  consume: (nonce: string, expires: number) => MaybePromise<boolean>
}

/** Creates a process-local nonce store suitable for a single server instance. */
export function createNonceStore(): NonceStore {
  const values = new Map<string, number>()
  return {
    consume(nonce, expires) {
      const now = Date.now()
      for (const [value, expires] of values) if (expires <= now) values.delete(value)
      if (values.has(nonce)) return true
      values.set(nonce, expires)
      return false
    },
  }
}

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
  const parameters = new Map<string, BareItem>([
    ['created', created],
    ['expires', expires],
    ['keyid', options.keyId],
    ['alg', Constants.algorithms.ed25519],
    ['nonce', context.nonce],
    ['tag', options.tag],
  ])
  const input: SignatureInput = {
    algorithm: Constants.algorithms.ed25519,
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
    'Ed25519',
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
    nonceStore?: NonceStore | undefined
    requiredComponents: readonly string[]
    tag: string | readonly string[]
    validate?: ((input: SignatureInput, request: Request) => string | undefined) | undefined
  },
): Promise<{ input?: SignatureInput; reason?: string }> {
  const parsed = parse(request, options.tag)
  if (!parsed) return {}
  if (parsed.reason) return { reason: parsed.reason }
  if (!parsed.input || !parsed.signature)
    return { reason: 'The HTTP message signature is malformed.' }
  const { input, signature } = parsed

  if (!options.requiredComponents.every((component) => hasComponent(input.components, component)))
    return { reason: 'The signature does not cover the required request components.' }
  const now = Math.floor(Date.now() / 1000)
  if (input.created > now || input.expires <= now || input.expires - input.created > options.maxAge)
    return { reason: 'The signature is expired or has an invalid lifetime.' }
  if (options.validate) {
    const reason = options.validate(input, request)
    if (reason) return { reason }
  }
  const key = await options.keyResolver({ keyId: input.keyId, request })
  if (!key) return { reason: 'No public key is available for the signature key ID.' }
  const valid = await crypto.subtle.verify(
    'Ed25519',
    key,
    toArrayBuffer(signature),
    toArrayBuffer(encode(signatureBase(request, input))),
  )
  if (!valid) return { reason: 'The HTTP message signature is invalid.' }
  if (
    options.nonceStore &&
    (await options.nonceStore.consume(
      `${input.tag}:${input.keyId}:${input.nonce}`,
      input.expires * 1000,
    ))
  )
    return { reason: 'The signature nonce has already been used.' }
  return { input }
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
    algorithm !== Constants.algorithms.ed25519 ||
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
