import { Base64, Bytes, Hex } from 'ox'
import { getAddress, recoverMessageAddress, type Account, type Address, type Client } from 'viem'
import { getChainId, verifyMessage } from 'viem/actions'
import { createSiweMessage } from 'viem/siwe'

import * as Store from '../Store.js'
import * as z from '../zod.js'
import * as Types from './Types.js'

/** Key of the x402 `sign-in-with-x` (SIWX) extension in a 402's `extensions`. */
export const extensionKey = 'sign-in-with-x'

/** Request header that carries a signed SIWX proof as base64-encoded JSON. */
export const header = 'SIGN-IN-WITH-X'

/** How long a SIWX challenge stays valid, in milliseconds. */
export const ttl = 5 * 60 * 1000

/**
 * Machine-readable codes for a rejected proof, as the x402 SIWX spec names them.
 *
 * @see https://github.com/coinbase/x402/blob/main/specs/extensions/sign-in-with-x.md
 */
export type ErrorCode =
  | 'invalid_siwx_payload'
  | 'invalid_siwx_domain_mismatch'
  | 'invalid_siwx_uri_mismatch'
  | 'invalid_siwx_issued_at'
  | 'invalid_siwx_issued_at_too_old'
  | 'invalid_siwx_issued_at_in_future'
  | 'invalid_siwx_expiration_time'
  | 'invalid_siwx_expired'
  | 'invalid_siwx_not_before'
  | 'invalid_siwx_not_yet_valid'
  | 'invalid_siwx_nonce'
  | 'invalid_siwx_signature'
  | 'invalid_siwx_chain_id'
  | 'invalid_siwx_unsupported_chain'
  | 'invalid_siwx_verifier_error'

/** A signing method a server accepts. */
export const ChainSchema = z.object({
  chainId: z.string(),
  signatureScheme: z.optional(z.string()),
  type: z.string(),
})

/** A signing method a server accepts. */
export type Chain = z.infer<typeof ChainSchema>

/** Message fields a server declares in its 402. */
export const InfoSchema = z.object({
  domain: z.string(),
  expirationTime: z.optional(z.string()),
  issuedAt: z.string(),
  nonce: z.string(),
  notBefore: z.optional(z.string()),
  requestId: z.optional(z.string()),
  resources: z.optional(z.array(z.string())),
  statement: z.optional(z.string()),
  uri: z.string(),
  version: z.string(),
})

/** Message fields a server declares in its 402. */
export type Info = z.infer<typeof InfoSchema>

/** The extension's value in a 402's `extensions`. */
export const ExtensionSchema = z.object({
  info: InfoSchema,
  schema: z.record(z.string(), z.unknown()),
  supportedChains: z.array(ChainSchema),
})

/** The extension's value in a 402's `extensions`. */
export type Extension = z.infer<typeof ExtensionSchema>

/** The signed proof a client sends in the {@link header}. */
export const PayloadSchema = z.object({
  ...InfoSchema.shape,
  address: z.string(),
  chainId: z.string(),
  signature: z.string(),
  signatureScheme: z.optional(z.string()),
  type: z.string(),
})

/** The signed proof a client sends in the {@link header}. */
export type Payload = z.infer<typeof PayloadSchema>

/** JSON Schema of a {@link Payload}, advertised in the 402 as the spec requires. */
export const payloadJsonSchema = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  properties: {
    address: { type: 'string' },
    chainId: { type: 'string' },
    domain: { type: 'string' },
    expirationTime: { format: 'date-time', type: 'string' },
    issuedAt: { format: 'date-time', type: 'string' },
    nonce: { type: 'string' },
    notBefore: { format: 'date-time', type: 'string' },
    requestId: { type: 'string' },
    resources: { items: { format: 'uri', type: 'string' }, type: 'array' },
    signature: { type: 'string' },
    statement: { type: 'string' },
    type: { type: 'string' },
    uri: { format: 'uri', type: 'string' },
    version: { type: 'string' },
  },
  required: [
    'domain',
    'address',
    'uri',
    'version',
    'chainId',
    'type',
    'nonce',
    'issuedAt',
    'signature',
  ],
  type: 'object',
} as const

/** Error for a proof the server rejects. Its message is the spec's {@link ErrorCode}. */
export class InvalidProofError extends Error {
  override readonly name = 'Siwx.InvalidProofError'
  /** The spec's machine-readable code for the failed check. */
  readonly code: ErrorCode

  constructor(code: ErrorCode) {
    super(code)
    this.code = code
  }
}

/**
 * Builds the EIP-4361 (SIWE) message a payload signs.
 *
 * The layout is viem's `createSiweMessage`, which also validates the fields, but timestamps
 * are signed exactly as the payload carries them, as the x402 reference does, so a proof
 * with any RFC 3339 timestamp verifies across implementations.
 */
export function toMessage(payload: Omit<Payload, 'signature'>): string {
  const issuedAt = timestamp(payload.issuedAt, 'issuedAt')
  const expirationTime = payload.expirationTime
    ? timestamp(payload.expirationTime, 'expirationTime')
    : undefined
  const notBefore = payload.notBefore ? timestamp(payload.notBefore, 'notBefore') : undefined
  const address = getAddress(payload.address)
  const chainId = chainIdOf(payload.chainId)
  // Throws for a field the SIWE format rejects.
  createSiweMessage({
    address,
    chainId,
    domain: payload.domain,
    ...(expirationTime ? { expirationTime: new Date(expirationTime) } : {}),
    issuedAt: new Date(issuedAt),
    nonce: payload.nonce,
    ...(notBefore ? { notBefore: new Date(notBefore) } : {}),
    ...(payload.requestId ? { requestId: payload.requestId } : {}),
    ...(payload.resources ? { resources: payload.resources } : {}),
    ...(payload.statement ? { statement: payload.statement } : {}),
    uri: payload.uri,
    version: '1',
  })
  if (payload.requestId?.includes('\n')) throw new Error('Invalid SIWE message field requestId')

  let prefix = `${payload.domain} wants you to sign in with your Ethereum account:\n${address}\n\n`
  if (payload.statement) prefix += `${payload.statement}\n`
  const lines = [
    `URI: ${payload.uri}`,
    'Version: 1',
    `Chain ID: ${chainId}`,
    `Nonce: ${payload.nonce}`,
    `Issued At: ${issuedAt}`,
  ]
  if (expirationTime) lines.push(`Expiration Time: ${expirationTime}`)
  if (notBefore) lines.push(`Not Before: ${notBefore}`)
  if (payload.requestId) lines.push(`Request ID: ${payload.requestId}`)
  if (payload.resources) {
    lines.push('Resources:')
    for (const resource of payload.resources) lines.push(`- ${resource}`)
  }
  return `${prefix}\n${lines.join('\n')}`
}

/** An RFC 3339 date-time, as SIWE timestamps are. */
const timestampPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/

function timestamp(value: string, field: string): string {
  if (!timestampPattern.test(value) || Number.isNaN(Date.parse(value)))
    throw new Error(`Invalid SIWE message field ${field}`)
  return value
}

/** Encodes a payload as a {@link header} value. */
export function encode(payload: Payload): string {
  return Base64.fromString(JSON.stringify(payload))
}

/** Decodes a {@link header} value. Throws {@link InvalidProofError} when it is malformed. */
export function decode(value: string): Payload {
  try {
    return PayloadSchema.parse(JSON.parse(Base64.toString(value)))
  } catch {
    throw new InvalidProofError('invalid_siwx_payload')
  }
}

/** Reads the SIWX extension from a decoded x402 402 body, if it offers one. */
export function fromPaymentRequired(paymentRequired: {
  extensions?: Record<string, unknown> | undefined
}): Extension | undefined {
  const result = ExtensionSchema.safeParse(paymentRequired.extensions?.[extensionKey])
  return result.success ? result.data : undefined
}

/** Builds the extension a server adds to a 402, with a fresh nonce. */
export function createExtension(parameters: {
  /** EVM chain ID the server accepts signatures for. */
  chainId: number
  /** The server's public origin. */
  origin: string
  /** URL of the requested resource. */
  url: string
}): Extension {
  const { chainId, url } = parameters
  const origin = new URL(parameters.origin)
  const now = Date.now()
  return {
    info: {
      domain: origin.host,
      expirationTime: new Date(now + ttl).toISOString(),
      issuedAt: new Date(now).toISOString(),
      nonce: Hex.fromBytes(Bytes.random(16)).slice(2),
      uri: origin.origin + siweSafe(new URL(url).pathname + new URL(url).search),
      version: '1',
    },
    schema: payloadJsonSchema,
    supportedChains: [{ chainId: `eip155:${chainId}`, type: 'eip191' }],
  }
}

/**
 * Percent-encodes the characters a URL's path and query may keep (such as `|`, `{` or
 * `^`) that an RFC 3986 URI, and so a SIWE message's `URI`, can't hold, including a `%`
 * that doesn't start a valid percent escape.
 */
function siweSafe(pathAndQuery: string) {
  return pathAndQuery.replace(/[^A-Za-z0-9\-._~!$&'()*+,;=:@/?%]|%(?![0-9A-Fa-f]{2})/g, (char) =>
    Array.from(
      new TextEncoder().encode(char),
      (byte) => `%${byte.toString(16).toUpperCase().padStart(2, '0')}`,
    ).join(''),
  )
}

/** Server options for accepting SIWX proofs on an x402 route. */
export type ServerOptions = {
  /**
   * Client for verifying smart-wallet (EIP-1271 and EIP-6492) signatures with an RPC call.
   * It must serve the offer's chain: proofs for another chain are rejected.
   * Without it, only EOA signatures verify.
   */
  client?: Client | undefined
  /**
   * Decides whether a wallet that proved its address gets the resource without paying.
   * Return `false` to answer 402 so it pays.
   */
  grant: (parameters: {
    /** Address the proof recovered. */
    address: Address
    /** EVM chain ID the proof was signed for. */
    chainId: number
    /** The request being authorized. */
    request: Request
  }) => boolean | Promise<boolean>
  /**
   * Public origin of the server as clients see it, such as `https://api.example.com`.
   * Proofs must name it. It is never taken from request headers such as `Host`,
   * which a caller controls.
   */
  origin: string
  /**
   * Atomic store that records used nonces, so each proof is accepted once. In a composed
   * route, give offers that share a backend the same store object: each store object
   * records the nonce on its own, so two objects over one backend refuse a later offer.
   */
  store: Store.AtomicStore
}

/**
 * Verifies a SIWX proof against the server's origin and chain. It does not record the
 * nonce: call {@link claim} once the proof is used, so a check that declines the wallet
 * leaves the proof for another.
 * Throws {@link InvalidProofError} with the spec's code when the proof is rejected.
 */
export async function verify(parameters: {
  /** EVM chain ID the server accepts signatures for. */
  chainId: number
  /** The server's SIWX options. */
  options: Pick<ServerOptions, 'client' | 'origin'>
  /** The decoded proof. */
  payload: Payload
}): Promise<{ address: Address; chainId: number }> {
  const { options, payload } = parameters
  const origin = new URL(options.origin)
  const now = Date.now()

  if (payload.domain !== origin.host) throw new InvalidProofError('invalid_siwx_domain_mismatch')
  if (originOf(payload.uri) !== origin.origin)
    throw new InvalidProofError('invalid_siwx_uri_mismatch')

  const issuedAt = Date.parse(payload.issuedAt)
  if (Number.isNaN(issuedAt)) throw new InvalidProofError('invalid_siwx_issued_at')
  if (issuedAt > now + clockSkew) throw new InvalidProofError('invalid_siwx_issued_at_in_future')
  if (now - issuedAt > ttl) throw new InvalidProofError('invalid_siwx_issued_at_too_old')
  if (payload.expirationTime !== undefined) {
    const expires = Date.parse(payload.expirationTime)
    if (Number.isNaN(expires)) throw new InvalidProofError('invalid_siwx_expiration_time')
    if (expires <= now) throw new InvalidProofError('invalid_siwx_expired')
  }
  if (payload.notBefore !== undefined) {
    const notBefore = Date.parse(payload.notBefore)
    if (Number.isNaN(notBefore)) throw new InvalidProofError('invalid_siwx_not_before')
    if (notBefore > now) throw new InvalidProofError('invalid_siwx_not_yet_valid')
  }

  if (!payload.chainId.startsWith('eip155:'))
    throw new InvalidProofError('invalid_siwx_unsupported_chain')
  const chainId = chainIdOf(payload.chainId)
  if (chainId !== parameters.chainId) throw new InvalidProofError('invalid_siwx_unsupported_chain')
  // EIP-4361 nonces are at least 8 alphanumeric characters.
  if (!/^[a-zA-Z0-9]{8,}$/.test(payload.nonce)) throw new InvalidProofError('invalid_siwx_nonce')

  let address: Address
  try {
    address = getAddress(payload.address)
  } catch {
    throw new InvalidProofError('invalid_siwx_payload')
  }
  if (!/^0x[0-9a-fA-F]+$/.test(payload.signature))
    throw new InvalidProofError('invalid_siwx_signature')
  const signature = payload.signature as Hex.Hex
  let message: string
  try {
    message = toMessage(payload)
  } catch {
    // A field the SIWE format rejects, such as a statement with a newline or an invalid URI.
    throw new InvalidProofError('invalid_siwx_payload')
  }

  // A smart-wallet signature is checked against contract state, so it must be the state of
  // the chain the proof names.
  if (options.client) {
    let clientChainId: number
    try {
      clientChainId = options.client.chain?.id ?? (await getChainId(options.client))
    } catch {
      throw new InvalidProofError('invalid_siwx_verifier_error')
    }
    if (clientChainId !== chainId) throw new InvalidProofError('invalid_siwx_verifier_error')
  }

  let valid: boolean
  try {
    valid = options.client
      ? await verifyMessage(options.client, { address, message, signature })
      : getAddress(await recoverMessageAddress({ message, signature })) === address
  } catch {
    if (options.client) throw new InvalidProofError('invalid_siwx_verifier_error')
    valid = false
  }
  if (!valid) throw new InvalidProofError('invalid_siwx_signature')

  return { address, chainId }
}

/**
 * Records a verified proof's nonce so it is accepted once.
 * Throws {@link InvalidProofError} with `invalid_siwx_nonce` when it was already used.
 */
export async function claim(parameters: {
  /** The verified proof. */
  payload: Pick<Payload, 'issuedAt' | 'nonce'>
  /** Atomic store that records used nonces. */
  store: Store.AtomicStore
}): Promise<void> {
  const { payload, store } = parameters
  const claimed = await Store.tryClaim(store, nonceKey(payload), claimExpires(payload))
  if (!claimed) throw new InvalidProofError('invalid_siwx_nonce')
}

/**
 * Releases a nonce {@link claim} recorded, so the proof can be accepted again. Call it
 * only for a claim this request made, such as when `grant` declines the wallet.
 * Does nothing once that claim has expired, since another request may hold the nonce by then.
 */
export async function release(parameters: {
  /** The claimed proof. */
  payload: Pick<Payload, 'issuedAt' | 'nonce'>
  /** The store `claim` recorded the nonce in. */
  store: Store.AtomicStore
}): Promise<void> {
  const { payload, store } = parameters
  // Until this request's claim expires nobody else can claim the nonce, so the stored marker
  // is still this request's own. Close to expiry the claim is left to lapse instead. `delete`
  // (not `update`) is what frees a native claim, such as one in a Durable Object replay shard.
  if (Date.now() + releaseMargin >= claimExpires(payload)) return
  await store.delete(nonceKey(payload))
}

/** How long before a claim expires {@link release} stops deleting it. */
const releaseMargin = 5_000

function nonceKey(payload: Pick<Payload, 'nonce'>) {
  return `mppx:x402:siwx:${payload.nonce}`
}

function claimExpires(payload: Pick<Payload, 'issuedAt'>) {
  return Date.parse(payload.issuedAt) + ttl + clockSkew
}

/**
 * Wraps `fetch` so a 402 that offers SIWX is answered once with a proof signed by
 * `account`, before any payment. Pass the result as the `fetch` of an mppx client:
 * when the server still answers 402 because it doesn't grant this wallet, mppx pays
 * from that response as usual.
 *
 * It signs only when the challenge's `domain` and `uri` origin match the URL that
 * returned the 402, and only for `eip155` chains.
 *
 * @example
 * ```ts
 * import { Fetch, evm } from 'mppx/client'
 * import { Siwx } from 'mppx/x402'
 *
 * const fetch = Fetch.from({
 *   fetch: Siwx.wrapFetch(globalThis.fetch, { account }),
 *   methods: [evm({ account })],
 * })
 * ```
 */
export function wrapFetch(
  fetch: typeof globalThis.fetch,
  parameters: wrapFetch.Parameters,
): typeof globalThis.fetch {
  const { account } = parameters
  return async (input, init) => {
    // A streamed upload can't be sent again without holding all of it in memory, so it
    // passes through untouched and a 402 for it is paid as usual.
    if (isStreamed(input, init)) return fetch(input, init)
    const request = new Request(input, init)
    // Keep a copy so a request body can be sent again with the proof.
    const retry = request.clone()
    // A Request drops init's symbol-keyed controls, such as mppx's payment opt-out, so
    // they are passed along beside it on every call.
    const controls = symbolControls(init)
    const response = await fetch(request, controls)
    if (
      response.status !== 402 ||
      request.headers.has(header) ||
      carriesPayment(request.headers) ||
      carriesSingleUseProof(request.headers) ||
      // A 402 reached through a redirect is left to payment: the retry goes to the requested
      // URL without following redirects, and would send a redirected POST's body again.
      response.redirected ||
      !account.signMessage
    )
      return response

    const value = response.headers.get(Types.paymentRequiredHeader)
    if (!value) return response
    let extension: Extension | undefined
    try {
      extension = fromPaymentRequired(JSON.parse(Base64.toString(value)))
    } catch {
      return response
    }
    if (!extension) return response

    const chain = extension.supportedChains.find(
      (entry) => entry.chainId.startsWith('eip155:') && entry.type === 'eip191',
    )
    if (!chain) return response

    // A challenge naming another site must never get this wallet's signature. The retry
    // goes to the requested URL, so a challenge reached through a cross-origin redirect
    // is refused too: signing it would hand the redirecting site the proof.
    const target = new URL(request.url)
    if (response.url && new URL(response.url).origin !== target.origin) return response
    if (extension.info.domain !== target.host || originOf(extension.info.uri) !== target.origin)
      return response

    const unsigned = {
      ...extension.info,
      address: account.address,
      chainId: chain.chainId,
      type: chain.type,
      ...(chain.signatureScheme ? { signatureScheme: chain.signatureScheme } : {}),
    }
    let message: string
    try {
      message = toMessage(unsigned)
    } catch {
      // A challenge the SIWE format can't encode can't be signed: leave the 402 to payment.
      return response
    }
    const signature = await account.signMessage({ message })
    // Not awaited: a fetch that kept a clone of the response would hold the cancel open.
    response.body?.cancel().catch(() => {})
    const headers = new Headers(retry.headers)
    headers.set(header, encode({ ...unsigned, signature }))
    // Redirects aren't followed, so no redirect can carry the proof to another site.
    return fetch(new Request(retry, { headers, redirect: 'manual' }), controls)
  }
}

/** The symbol-keyed entries of a fetch `init`, which a `Request` doesn't keep. */
function symbolControls(init: RequestInit | undefined): RequestInit | undefined {
  if (!init) return undefined
  const symbols = Object.getOwnPropertySymbols(init)
  if (symbols.length === 0) return undefined
  const controls: Record<symbol, unknown> = {}
  for (const symbol of symbols) controls[symbol] = (init as Record<symbol, unknown>)[symbol]
  return controls as RequestInit
}

/**
 * Whether a request already carries a payment credential. Its 402 means the payment was
 * refused, so it is returned as is rather than sending the same credential again with a proof.
 */
function carriesPayment(headers: Headers) {
  if (headers.has(Types.paymentSignatureHeader) || headers.has(Types.legacyPaymentSignatureHeader))
    return true
  return /^payment\s/i.test(headers.get('authorization') ?? '')
}

/**
 * Whether a request carries an identity proof bound to a single send, such as an HTTP message
 * signature (Web Bot Auth, TAP) or a DPoP proof. Resending it with a SIWX proof would be
 * refused as a replay, so its 402 is returned as is and the caller's own retry signs afresh.
 */
function carriesSingleUseProof(headers: Headers) {
  return headers.has('signature-input') || headers.has('dpop')
}

export declare namespace wrapFetch {
  type Parameters = {
    /** Account that signs SIWX challenges. Must be able to sign messages. */
    account: Account
  }
}

/** Tolerance for client clocks that run slightly ahead of the server. */
const clockSkew = 60 * 1000

function chainIdOf(value: string): number {
  const match = /^eip155:(\d+)$/.exec(value)
  if (!match) throw new InvalidProofError('invalid_siwx_chain_id')
  return Number(match[1])
}

/** Whether a request's body is a stream, rather than a value that can be sent again. */
function isStreamed(input: RequestInfo | URL, init: RequestInit | undefined): boolean {
  if (init?.body !== undefined && init.body !== null) return init.body instanceof ReadableStream
  return input instanceof Request && input.body !== null
}

function originOf(value: string): string | undefined {
  try {
    return new URL(value).origin
  } catch {
    return undefined
  }
}
