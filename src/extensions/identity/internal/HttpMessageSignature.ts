import { Base64 } from 'ox'
import {
  isInnerList,
  parseDictionary,
  serializeItem,
  serializeDictionary,
  serializeInnerList,
  serializeParameters,
} from 'structured-headers'
import type { BareItem, Dictionary, InnerList, Item } from 'structured-headers'

import { constantTimeEqual } from '../../../internal/constantTimeEqual.js'
import type { MaybePromise } from '../../../internal/types.js'
import * as Store from '../../../Store.js'
import { Algorithms, Headers as SignatureHeaders } from '../Constants.js'
import type { KeyResolver, SignatureAlgorithm, SigningContext, SigningKey } from '../Types.js'
import * as Signer from './Signer.js'
import * as SigningContextInternal from './SigningContext.js'

/** RFC 9421 constants used by identity signature profiles. */
export const Constants = {
  /** Derived request components supported by this narrow request profile. */
  components: {
    /** The target host and non-default port. */
    authority: '@authority',
    /** The RFC 9530 `Content-Digest` request header, checked against the body. */
    contentDigest: 'content-digest',
    /** The case-sensitive HTTP request method. */
    method: '@method',
    /** The request URL path without its query string. */
    path: '@path',
    /** The query string, including the leading `?`, or `?` when absent. */
    query: '@query',
    /** The lowercased request URL scheme without its trailing colon. */
    scheme: '@scheme',
    /** The lowercased `Signature-Agent` request header. */
    signatureAgent: 'signature-agent',
    /** The signature's canonicalized covered-components and parameters. */
    signatureParams: '@signature-params',
  },
} as const

const algorithmDescriptors = {
  [Algorithms.ed25519]: {
    hash: undefined,
    keyAlgorithm: 'Ed25519',
    namedCurve: undefined,
    webCryptoAlgorithm: 'Ed25519',
  },
  [Algorithms.ecdsaP256Sha256]: {
    hash: undefined,
    keyAlgorithm: 'ECDSA',
    namedCurve: 'P-256',
    webCryptoAlgorithm: { name: 'ECDSA', hash: 'SHA-256' },
  },
  [Algorithms.ecdsaP384Sha384]: {
    hash: undefined,
    keyAlgorithm: 'ECDSA',
    namedCurve: 'P-384',
    webCryptoAlgorithm: { name: 'ECDSA', hash: 'SHA-384' },
  },
  [Algorithms.rsaPssSha512]: {
    hash: 'SHA-512',
    keyAlgorithm: 'RSA-PSS',
    namedCurve: undefined,
    webCryptoAlgorithm: { name: 'RSA-PSS', saltLength: 64 },
  },
} as const satisfies Record<
  SignatureAlgorithm,
  {
    hash: string | undefined
    keyAlgorithm: string
    namedCurve: string | undefined
    webCryptoAlgorithm: AlgorithmIdentifier | RsaPssParams | EcdsaParams
  }
>

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
    key: SigningKey
    label: string
    context?: SigningContext | undefined
    tag: string
  },
): Promise<Request> {
  const context = options.context ?? SigningContextInternal.create()
  const created = context.created
  const expires = created + (options.expiresIn ?? 60)
  const signer = Signer.resolve(options.key)
  const algorithm = signer.algorithm
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
  if (!hasValidComponents(input.components))
    throw new Error('Covered components must be unique and must not include "@signature-params".')
  // Check the existing signatures first, so a request this refuses never reaches a remote signer.
  const headers = new Headers(request.headers)
  const inputs = parseHeaderDictionary(headers, SignatureHeaders.signatureInput)
  const signatures = parseHeaderDictionary(headers, SignatureHeaders.signature)
  if (!haveSameKeys(inputs, signatures))
    throw new Error('Signature-Input and Signature must contain the same labels.')
  if (inputs.has(input.label) || signatures.has(input.label))
    throw new Error(`HTTP message signature label "${input.label}" already exists.`)
  // `new Request(request)` below throws on a read or locked body: refuse it before signing.
  if (request.bodyUsed || request.body?.locked)
    throw new TypeError('Cannot sign a request whose body has already been read or is locked.')
  inputs.set(input.label, toInnerList(input))
  // Serializing validates the label and parameters before the signer is called.
  const signatureInput = serializeDictionary(inputs)
  const bytes = encode(signatureBase(request, input))
  const signature = (await signer.sign(bytes)).buffer
  signatures.set(input.label, [signature, new Map()])
  headers.set(SignatureHeaders.signatureInput, signatureInput)
  headers.set(SignatureHeaders.signature, serializeDictionary(signatures))
  return new Request(request, { headers })
}

/** Verifies a request signature, its lifetime, and optionally its nonce. */
export async function verify(
  request: Request,
  options: {
    keyResolver: KeyResolver
    maxAge: number
    /** Seconds a signer's clock may differ from this one. @default 0 */
    clockSkew?: number | undefined
    nonceNamespace: string
    /**
     * Whether a nonce is single-use per key ID (`'key'`) or across every key in the namespace
     * (`'namespace'`). @default 'key'
     */
    nonceScope?: 'key' | 'namespace' | undefined
    nonceStore: Store.AtomicStore
    requiredComponents: readonly string[]
    tag: string | readonly string[]
    /** Rejects a request carrying more than one signature with an expected tag. @default false */
    unique?: boolean | undefined
    /** Algorithms this profile accepts. @default every algorithm in {@link Algorithms} */
    algorithms?: readonly SignatureAlgorithm[] | undefined
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
  const parsed = parse(request, options.tag, options.unique ?? false)
  if (!parsed) return { status: 'absent' }
  if (parsed.reason) return { status: 'invalid', reason: parsed.reason }
  if (!parsed.input || !parsed.signature)
    return { status: 'invalid', reason: 'The HTTP message signature is malformed.' }
  const { input, signature } = parsed
  if (options.algorithms && !options.algorithms.includes(input.algorithm))
    return { status: 'invalid', reason: 'The signature algorithm is not supported.' }

  if (!options.requiredComponents.every((component) => hasComponent(input.components, component)))
    return {
      status: 'invalid',
      reason: 'The signature does not cover the required request components.',
    }
  const skew = options.clockSkew ?? 0
  const now = Math.floor(Date.now() / 1000)
  if (
    input.created > now + skew ||
    input.expires <= now - skew ||
    input.expires - input.created > options.maxAge
  )
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
  if (hasComponent(input.components, Constants.components.contentDigest)) {
    // A digest is checked only when the whole field is signed: covering one member (`;key=`)
    // would let an unsigned member stand in for it.
    if (!coversWholeField(input.components, Constants.components.contentDigest))
      return {
        status: 'invalid',
        reason: 'The signature must cover the whole Content-Digest field.',
      }
    const reason = await checkContentDigest(request)
    if (reason) return { status: 'invalid', reason }
  }
  try {
    if (
      !(await claimNonce(
        options.nonceStore,
        options.nonceNamespace,
        options.nonceScope,
        input,
        // Held for as long as the skewed lifetime check could still accept the signature.
        (input.expires + skew) * 1000,
      ))
    )
      return { status: 'invalid', reason: 'The signature nonce has already been used.' }
  } catch {
    return { status: 'unverified', reason: 'Replay protection is unavailable.' }
  }
  if (input.expires <= Math.floor(Date.now() / 1000) - skew)
    return { status: 'invalid', reason: 'The signature has expired.' }
  return { status: 'verified', input }
}

/**
 * Claims a signature's nonce. A namespace-wide claim also claims the per-key ID entry, so a
 * verifier that still claims per key (an earlier release, mid-deploy) refuses a nonce this one
 * accepted, and this one refuses a nonce such a verifier accepted.
 */
async function claimNonce(
  store: Store.AtomicStore,
  namespace: string,
  scope: 'key' | 'namespace' | undefined,
  input: SignatureInput,
  expires: number,
): Promise<boolean> {
  const perKey = await Store.tryClaim(store, `${namespace}:${input.keyId}:${input.nonce}`, expires)
  if (scope !== 'namespace') return perKey
  const shared = await Store.tryClaim(store, `${namespace}:${input.nonce}`, expires)
  return perKey && shared
}

function parse(
  request: Request,
  expectedTag: string | readonly string[],
  unique: boolean,
): { input?: SignatureInput; reason?: string; signature?: Uint8Array } | undefined {
  const inputHeader = request.headers.get(SignatureHeaders.signatureInput)
  const signatureHeader = request.headers.get(SignatureHeaders.signature)
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
  if (unique && [...inputs.values()].filter((entry) => hasExpectedTag(entry, tags)).length > 1)
    return { reason: 'More than one matching HTTP message signature was provided.' }
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
  if (!hasValidComponents(components)) return undefined
  const created = parameters.get('created')
  const expires = parameters.get('expires')
  const algorithm = parameters.get('alg')
  const keyId = parameters.get('keyid')
  const nonce = parameters.get('nonce')
  const tag = parameters.get('tag')
  if (
    !isInteger(created) ||
    !isInteger(expires) ||
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

function isInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value)
}

function isSignatureAlgorithm(value: unknown): value is SignatureAlgorithm {
  return typeof value === 'string' && Object.hasOwn(algorithmDescriptors, value)
}

function keySupportsAlgorithm(key: CryptoKey, algorithm: SignatureAlgorithm): boolean {
  const { hash, keyAlgorithm, namedCurve } = algorithmDescriptors[algorithm]
  return (
    key.algorithm.name === keyAlgorithm &&
    (!hash || (key.algorithm as RsaHashedKeyAlgorithm).hash.name === hash) &&
    (!namedCurve || (key.algorithm as EcKeyAlgorithm).namedCurve === namedCurve)
  )
}

function webCryptoAlgorithm(
  algorithm: SignatureAlgorithm,
): AlgorithmIdentifier | RsaPssParams | EcdsaParams {
  return algorithmDescriptors[algorithm].webCryptoAlgorithm
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
  if (component.id === Constants.components.method) {
    if (component.parameters?.size) throw new Error('Unsupported parameters for "@method".')
    return request.method
  }
  if (component.id === Constants.components.authority) {
    if (component.parameters?.size) throw new Error('Unsupported parameters for "@authority".')
    return url.host
  }
  if (component.id === Constants.components.path) {
    if (component.parameters?.size) throw new Error('Unsupported parameters for "@path".')
    return url.pathname
  }
  if (component.id === Constants.components.query) {
    if (component.parameters?.size) throw new Error('Unsupported parameters for "@query".')
    return url.search || '?'
  }
  if (component.id === Constants.components.scheme) {
    if (component.parameters?.size) throw new Error('Unsupported parameters for "@scheme".')
    return url.protocol.slice(0, -1)
  }
  if (component.parameters?.size)
    return componentDictionaryValue(request, component.id, component.parameters)
  const value = request.headers.get(component.id)
  if (value === null) throw new Error(`Missing signed HTTP header "${component.id}".`)
  // RFC 9421 signs the serialized field value, not a Unicode-normalized string.
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

/** Whether `id` is covered without parameters, so its whole field value is signed. */
export function coversWholeField(components: readonly Component[], id: string): boolean {
  return components.some((component) => component.id === id && !component.parameters?.size)
}

/** RFC 9421 §2.5: each component is covered at most once, and never `@signature-params`. */
function hasValidComponents(components: readonly Component[]): boolean {
  const identifiers = components.map(serializeComponent)
  return (
    new Set(identifiers).size === identifiers.length &&
    !components.some((component) => component.id === Constants.components.signatureParams)
  )
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

/** RFC 9530 digest algorithms this verifier checks, by their `Content-Digest` key. */
const digestAlgorithms = { 'sha-256': 'SHA-256', 'sha-512': 'SHA-512' } as const

/**
 * Returns a request with an RFC 9530 `sha-256` `Content-Digest` of its body, so a signature can
 * cover it. A request that already has the header is returned unchanged.
 */
export async function withContentDigest(request: Request): Promise<Request> {
  if (request.headers.has('content-digest')) return request
  if (request.bodyUsed || request.body?.locked)
    throw new TypeError('Cannot digest a request whose body has already been read or is locked.')
  const digest = await crypto.subtle.digest('SHA-256', await request.clone().arrayBuffer())
  const headers = new Headers(request.headers)
  headers.set('Content-Digest', `sha-256=:${Base64.fromBytes(new Uint8Array(digest))}:`)
  return new Request(request, { headers })
}

/**
 * Checks a covered `Content-Digest` against the request body. Every supported digest present must
 * match, and at least one must be present. Returns the reason it fails, or `undefined`.
 */
async function checkContentDigest(request: Request): Promise<string | undefined> {
  let digests: Dictionary
  try {
    digests = parseDictionary(request.headers.get('content-digest') ?? '')
  } catch {
    return 'The Content-Digest header is malformed.'
  }
  const expected: { algorithm: string; value: Uint8Array }[] = []
  for (const [key, algorithm] of Object.entries(digestAlgorithms)) {
    const member = digests.get(key)
    if (!member) continue
    if (isInnerList(member) || !(member[0] instanceof ArrayBuffer))
      return 'The Content-Digest header is malformed.'
    expected.push({ algorithm, value: new Uint8Array(member[0]) })
  }
  if (!expected.length) return 'The Content-Digest header has no supported digest.'
  if (request.bodyUsed || request.body?.locked)
    return 'The request body is unavailable to check its Content-Digest.'
  let body: ArrayBuffer
  try {
    body = await request.clone().arrayBuffer()
  } catch {
    return 'The request body could not be read to check its Content-Digest.'
  }
  for (const { algorithm, value } of expected) {
    const actual = new Uint8Array(await crypto.subtle.digest(algorithm, body))
    if (!constantTimeEqual(Base64.fromBytes(actual), Base64.fromBytes(value)))
      return 'The Content-Digest does not match the request body.'
  }
  return undefined
}

function encode(value: string): Uint8Array {
  return new TextEncoder().encode(value)
}

function toArrayBuffer(value: Uint8Array): ArrayBuffer {
  return Uint8Array.from(value).buffer
}
