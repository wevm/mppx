import { Base64 } from 'ox'
import type { Address, Hex } from 'viem'

import type * as Challenge from '../../../Challenge.js'

const maxUint96 = (1n << 96n) - 1n

/** Amount encoded by TIP20EscrowChannel as a `uint96` on-chain value. */
export type Uint96 = bigint

/** Decimal string containing raw token units, before applying token decimals. */
export type RawAmountString = string

/** Returns whether a bigint can be encoded as a TIP20EscrowChannel `uint96` amount. */
export function isUint96(value: bigint): value is Uint96 {
  return value >= 0n && value <= maxUint96
}

/** Converts a bigint into a TIP20EscrowChannel `uint96` amount after validating bounds. */
export function uint96(value: bigint): Uint96 {
  assertUint96(value)
  return value
}

/** Asserts that a bigint can be encoded as a TIP20EscrowChannel `uint96` amount. */
export function assertUint96(value: bigint): void {
  if (!isUint96(value)) throw new Error(`Value ${value} is outside uint96 bounds.`)
}

/** Full TIP-1034 channel descriptor used to derive and verify a channel ID. */
export type ChannelDescriptor = {
  /** Wallet that funds the channel and authorizes voucher spend. */
  payer: Address
  /** Wallet that receives settlement from the channel. */
  payee: Address
  /** Optional payee-side operator authorized for channel operations; zero address means unset. */
  operator: Address
  /** TIP-20 token escrowed by the channel. */
  token: Address
  /** Payer-selected entropy that makes otherwise identical descriptors unique. */
  salt: Hex
  /** Address authorized to sign vouchers; zero address delegates to `payer`. */
  authorizedSigner: Address
  /** Hash of the signed expiring-nonce open transaction required by TIP-1034. */
  expiringNonceHash: Hex
}

/** Public descriptor for a TIP-1034 session channel. */
export type SessionDescriptor = ChannelDescriptor

/**
 * Voucher for cumulative payment.
 * Cumulative monotonicity prevents replay attacks.
 */
export type Voucher = {
  channelId: Hex
  cumulativeAmount: bigint
}

/**
 * Signed voucher with EIP-712 signature.
 */
export type SignedVoucher = Voucher & { signature: Hex }

/**
 * Credential payload that opens a TIP-1034 precompile channel and authorizes initial spend.
 */
export type OpenCredentialPayload = {
  action: 'open'
  type: 'transaction'
  /** TIP-1034 channel ID derived from descriptor, escrow, and chain ID. */
  channelId: Hex
  /** Signed Tempo transaction containing the precompile `open` call. */
  transaction: Hex
  /** Voucher signature for `cumulativeAmount`. */
  signature: Hex
  /** Descriptor needed to recover and verify the channel. */
  descriptor: ChannelDescriptor
  /** Initial cumulative spend authorized by the opening voucher, as raw units. */
  cumulativeAmount: RawAmountString
  /** Voucher signer selected for the opened channel. */
  authorizedSigner?: Address | undefined
}

/**
 * Credential payload that adds deposit to an existing TIP-1034 precompile channel.
 */
export type TopUpCredentialPayload = {
  action: 'topUp'
  type: 'transaction'
  /** TIP-1034 channel ID being topped up. */
  channelId: Hex
  /** Signed Tempo transaction containing the precompile `topUp` call. */
  transaction: Hex
  /** Descriptor for the channel being topped up. */
  descriptor: ChannelDescriptor
  /** Additional deposit to add, as raw units. */
  additionalDeposit: RawAmountString
}

/**
 * Credential payload that increases cumulative spend authorization.
 */
export type VoucherCredentialPayload = {
  action: 'voucher'
  /** TIP-1034 channel ID the voucher applies to. */
  channelId: Hex
  /** Descriptor for the voucher's channel. */
  descriptor: ChannelDescriptor
  /** Highest cumulative spend authorized by this voucher, as raw units. */
  cumulativeAmount: RawAmountString
  /** Voucher signature for `cumulativeAmount`. */
  signature: Hex
}

/**
 * Credential payload that cooperatively closes a channel at final cumulative spend.
 */
export type CloseCredentialPayload = {
  action: 'close'
  /** TIP-1034 channel ID being closed. */
  channelId: Hex
  /** Descriptor for the channel being closed. */
  descriptor: ChannelDescriptor
  /** Final cumulative spend authorized at close, as raw units. */
  cumulativeAmount: RawAmountString
  /** Voucher signature for `cumulativeAmount`. */
  signature: Hex
}

/**
 * TIP20EscrowChannel precompile session credential payload (discriminated union).
 */
export type SessionCredentialPayload =
  | OpenCredentialPayload
  | TopUpCredentialPayload
  | VoucherCredentialPayload
  | CloseCredentialPayload

const sessionCredentialActions = new Set(['open', 'topUp', 'voucher', 'close'])

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object'
}

/**
 * Backend-neutral voucher for cumulative payment.
 * Cumulative monotonicity prevents replay attacks.
 */
export interface SessionVoucher {
  channelId: Hex
  cumulativeAmount: bigint
}

/**
 * Backend-neutral signed voucher with EIP-712 signature.
 */
export interface SessionSignedVoucher extends SessionVoucher {
  signature: Hex
}

/**
 * Management action names shared by session credential payloads.
 */
export type SessionCredentialAction = 'open' | 'topUp' | 'voucher' | 'close'

/**
 * Minimal credential shape shared by transport helpers that only need routing context.
 */
export type SessionCredentialContext = {
  /** Session channel ID referenced by the authorization payload. */
  channelId: Hex
  /** Session management action when the payload is a management credential. */
  action?: SessionCredentialAction | undefined
}

/** Returns whether a value is a supported session credential action. */
export function isSessionCredentialAction(value: unknown): value is SessionCredentialAction {
  return typeof value === 'string' && sessionCredentialActions.has(value)
}

/** Returns whether a value has the session credential fields needed by transports. */
export function isSessionCredentialContext(value: unknown): value is SessionCredentialContext {
  if (value === null || typeof value !== 'object') return false
  const candidate = value as { action?: unknown; channelId?: unknown }
  if (typeof candidate.channelId !== 'string') return false
  if (candidate.action !== undefined && !isSessionCredentialAction(candidate.action)) return false
  return true
}

/** Reads the shared session credential context or throws the provided error message. */
export function requireSessionCredentialContext(
  value: unknown,
  errorMessage = 'No session credential context available.',
): SessionCredentialContext {
  if (!isSessionCredentialContext(value)) throw new Error(errorMessage)
  return value
}

/** Reads the raw per-unit session amount from a payment challenge. */
export function readSessionChallengeAmount(challenge: Challenge.Challenge): bigint {
  const amount = challenge.request.amount
  if (typeof amount !== 'string') throw new Error('Session challenge is missing amount.')
  return BigInt(amount)
}

/**
 * SSE event emitted when session balance is exhausted mid-stream.
 * The client responds by sending a new voucher credential.
 *
 * Per spec §11.6, the event data contains:
 * - `channelId` — channel identifier
 * - `requiredCumulative` — minimum cumulative amount the next voucher must authorize
 * - `acceptedCumulative` — current highest accepted voucher amount
 * - `deposit` — current on-chain deposit ceiling; when `requiredCumulative > deposit`
 *   the client must top up the channel before sending a new voucher
 */
export interface NeedVoucherEvent {
  channelId: Hex
  /** Minimum cumulative voucher amount required to continue, as raw token units. */
  requiredCumulative: RawAmountString
  /** Highest cumulative voucher amount currently accepted by the server, as raw token units. */
  acceptedCumulative: RawAmountString
  /** Current channel deposit ceiling, as raw token units. */
  deposit: RawAmountString
}

/** Returns whether a value is a typed need-voucher event payload. */
export function isNeedVoucherEvent(value: unknown): value is NeedVoucherEvent {
  if (!isObject(value)) return false
  return (
    typeof value.channelId === 'string' &&
    typeof value.requiredCumulative === 'string' &&
    typeof value.acceptedCumulative === 'string' &&
    typeof value.deposit === 'string'
  )
}

/**
 * Session receipt returned in Payment-Receipt header.
 */
export interface SessionReceipt {
  /** Payment method that produced the receipt. */
  method: 'tempo'
  /** Payment intent that produced the receipt. */
  intent: 'session'
  /** Receipt status. */
  status: 'success'
  /** ISO timestamp when the receipt was created. */
  timestamp: string
  /** Payment reference (channelId). Satisfies Receipt.Receipt contract. */
  reference: string
  /** Challenge ID that this receipt settles or acknowledges. */
  challengeId: string
  /** TIP-1034 channel ID. */
  channelId: Hex
  /** Highest cumulative voucher amount accepted by the server, as raw token units. */
  acceptedCumulative: RawAmountString
  /** Amount actually consumed by delivered work/content, as raw token units. */
  spent: RawAmountString
  /** Paid units delivered by the server, when the transport reports them. */
  units?: number | undefined
  /** On-chain transaction hash when this receipt came from settlement or close. */
  txHash?: Hex | undefined
}

/** Returns whether a value is a typed session payment receipt. */
export function isSessionReceipt(value: unknown): value is SessionReceipt {
  if (!isObject(value)) return false
  return (
    value.method === 'tempo' &&
    value.intent === 'session' &&
    value.status === 'success' &&
    typeof value.timestamp === 'string' &&
    typeof value.reference === 'string' &&
    typeof value.challengeId === 'string' &&
    typeof value.channelId === 'string' &&
    typeof value.acceptedCumulative === 'string' &&
    typeof value.spent === 'string' &&
    (value.units === undefined || typeof value.units === 'number') &&
    (value.txHash === undefined || typeof value.txHash === 'string')
  )
}

/**
 * Create a session receipt.
 */
export function createSessionReceipt(params: {
  challengeId: string
  channelId: Hex
  acceptedCumulative: bigint
  spent: bigint
  units?: number | undefined
  txHash?: Hex | undefined
}): SessionReceipt {
  return {
    method: 'tempo',
    intent: 'session',
    status: 'success',
    timestamp: new Date().toISOString(),
    reference: params.channelId,
    challengeId: params.challengeId,
    channelId: params.channelId,
    acceptedCumulative: params.acceptedCumulative.toString(),
    spent: params.spent.toString(),
    ...(params.units !== undefined && { units: params.units }),
    ...(params.txHash !== undefined && { txHash: params.txHash }),
  }
}

/**
 * Serialize a session receipt to the Payment-Receipt header format.
 */
export function serializeSessionReceipt(receipt: SessionReceipt): string {
  const json = JSON.stringify(receipt)
  return Base64.fromString(json, { pad: false, url: true })
}

/**
 * Deserialize a Payment-Receipt header value to a session receipt.
 */
export function deserializeSessionReceipt(encoded: string): SessionReceipt {
  const json = Base64.toString(encoded)
  const value: unknown = JSON.parse(json)
  if (!isSessionReceipt(value)) throw new Error('Invalid session receipt.')
  return value
}

/**
 * Parsed SSE event (discriminated union by `type`).
 */
export type SseEvent =
  | { type: 'message'; data: string }
  | { type: 'payment-need-voucher'; data: NeedVoucherEvent }
  | { type: 'payment-receipt'; data: SessionReceipt }

/** Returns whether a response carries an SSE event stream. */
export function isEventStream(response: Response): boolean {
  const ct = response.headers.get('content-type')
  return ct?.toLowerCase().startsWith('text/event-stream') ?? false
}

/**
 * Format a session receipt as a Server-Sent Event.
 *
 * Produces a valid SSE event string with `event: payment-receipt`
 * and the receipt JSON as the `data` field.
 */
export function formatReceiptEvent(receipt: SessionReceipt): string {
  return `event: payment-receipt\ndata: ${JSON.stringify(receipt)}\n\n`
}

/**
 * Format a need-voucher event as a Server-Sent Event.
 *
 * Emitted when the channel balance is exhausted mid-stream.
 */
export function formatNeedVoucherEvent(params: NeedVoucherEvent): string {
  return `event: payment-need-voucher\ndata: ${JSON.stringify(params)}\n\n`
}

/**
 * Format an application message as SSE, preserving embedded newlines.
 *
 * SSE requires multi-line payloads to be emitted as separate `data:` fields.
 */
export function formatMessageEvent(value: string): string {
  const data = String(value)
    .split('\n')
    .map((line) => `data: ${line}`)
    .join('\n')
  return `event: message\n${data}\n\n`
}

/**
 * Parse a raw SSE event string into a typed event.
 *
 * Unknown event names fall back to `message`, which preserves compatibility
 * with generic SSE producers.
 */
export function parseEvent(raw: string): SseEvent | null {
  let eventType = 'message'
  const dataLines: string[] = []

  for (const line of raw.split('\n')) {
    if (line.startsWith('event: ')) {
      eventType = line.slice(7).trim()
    } else if (line.startsWith('data: ')) {
      dataLines.push(line.slice(6))
    } else if (line === 'data:') {
      dataLines.push('')
    }
  }

  if (dataLines.length === 0) return null
  const data = dataLines.join('\n')

  switch (eventType) {
    case 'message':
      return { type: 'message', data }
    case 'payment-need-voucher': {
      const parsed = parseJson(data)
      return isNeedVoucherEvent(parsed) ? { type: 'payment-need-voucher', data: parsed } : null
    }
    case 'payment-receipt': {
      const parsed = parseJson(data)
      return isSessionReceipt(parsed) ? { type: 'payment-receipt', data: parsed } : null
    }
    default:
      return { type: 'message', data }
  }
}

function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    return null
  }
}

/** Extracts the `data:` field value from a single SSE event block. */
export function extractData(event: string): string | null {
  const dataLines: string[] = []
  for (const line of event.split('\n')) {
    if (line.startsWith('data: ')) dataLines.push(line.slice(6))
    else if (line === 'data:') dataLines.push('')
  }
  return dataLines.length > 0 ? dataLines.join('\n') : null
}

/** In-band WebSocket payment protocol frame. */
export type Message =
  | { mpp: 'authorization'; authorization: string }
  | { mpp: 'message'; data: string }
  | { mpp: 'payment-close-request' }
  | { mpp: 'payment-close-ready'; data: SessionReceipt }
  | { mpp: 'payment-error'; status: number; message: string }
  | { mpp: 'payment-need-voucher'; data: NeedVoucherEvent }
  | { mpp: 'payment-receipt'; data: SessionReceipt }

/** Input for formatting a WebSocket payment protocol error frame. */
export type ErrorMessageParameters = {
  /** Human-readable error message. */
  message: string
  /** HTTP-style payment error status. */
  status: number
}

/** Formats the initial or follow-up payment authorization frame. */
export function formatAuthorizationMessage(authorization: string): string {
  return JSON.stringify({ mpp: 'authorization', authorization } satisfies Message)
}

/** Formats an application payload frame. */
export function formatApplicationMessage(data: string): string {
  return JSON.stringify({ mpp: 'message', data } satisfies Message)
}

/** Formats the client request for a final close-ready receipt. */
export function formatCloseRequestMessage(): string {
  return JSON.stringify({ mpp: 'payment-close-request' } satisfies Message)
}

/** Formats the server close-ready receipt frame. */
export function formatCloseReadyMessage(receipt: SessionReceipt): string {
  return JSON.stringify({ mpp: 'payment-close-ready', data: receipt } satisfies Message)
}

/** Formats a server request for a larger voucher. */
export function formatNeedVoucherMessage(params: NeedVoucherEvent): string {
  return JSON.stringify({ mpp: 'payment-need-voucher', data: params } satisfies Message)
}

/** Formats an intermediate or final payment receipt frame. */
export function formatReceiptMessage(receipt: SessionReceipt): string {
  return JSON.stringify({ mpp: 'payment-receipt', data: receipt } satisfies Message)
}

/** Formats a payment protocol error frame. */
export function formatErrorMessage(parameters: ErrorMessageParameters): string {
  return JSON.stringify({ mpp: 'payment-error', ...parameters } satisfies Message)
}

/** Parses a WebSocket payment protocol frame, returning null for application data. */
export function parseMessage(raw: string): Message | null {
  const parsed = parseJsonObject(raw)
  if (!parsed) return null
  if (parsed.mpp === 'authorization' && typeof parsed.authorization === 'string')
    return { mpp: 'authorization', authorization: parsed.authorization }
  if (parsed.mpp === 'message' && typeof parsed.data === 'string')
    return { mpp: 'message', data: parsed.data }
  if (parsed.mpp === 'payment-close-request') return { mpp: 'payment-close-request' }
  if (parsed.mpp === 'payment-close-ready' && isSessionReceipt(parsed.data))
    return { mpp: 'payment-close-ready', data: parsed.data }
  if (
    parsed.mpp === 'payment-error' &&
    typeof parsed.status === 'number' &&
    typeof parsed.message === 'string'
  )
    return { mpp: 'payment-error', status: parsed.status, message: parsed.message }
  if (parsed.mpp === 'payment-need-voucher' && isNeedVoucherEvent(parsed.data))
    return { mpp: 'payment-need-voucher', data: parsed.data }
  if (parsed.mpp === 'payment-receipt' && isSessionReceipt(parsed.data))
    return { mpp: 'payment-receipt', data: parsed.data }
  return null
}

function parseJsonObject(raw: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object') return null
    return value as Record<string, unknown>
  } catch {
    return null
  }
}

/** Canonical TIP-1034 TIP-20 Channel Escrow precompile address. */
export const tip20ChannelEscrow = '0x4d50500000000000000000000000000000000000'
