import type { Hex } from 'ox'

import * as Challenge from '../../../Challenge.js'
import * as Fetch from '../../../client/internal/Fetch.js'
import * as Constants from '../../../Constants.js'
import * as PaymentCredential from '../../../Credential.js'
import * as z from '../../../zod.js'
import * as Methods from '../../Methods.js'
import {
  deserializeSessionReceipt,
  isEventStream,
  parseEvent,
  readSessionChallengeAmount,
  uint96,
  type NeedVoucherEvent,
  type SessionCredentialPayload,
  type SessionReceipt,
} from '../precompile/Protocol.js'
import * as Ws from '../precompile/Protocol.js'
import type { ChannelEntry } from './ChannelOps.js'
import type { SessionContext } from './CredentialState.js'
import {
  activeStateFromChannel,
  activeStateFromReceipt,
  isExpectedCloseReceipt,
  parseManagerAmount,
  type CloseTarget,
  type SessionSnapshot,
  type SessionState,
} from './Runtime.js'

/** Runtime WebSocket constructor accepted by `sessionManager()` in non-browser environments. */
export type WebSocketConstructor = {
  new (url: string | URL, protocols?: string | string[]): WebSocket
}

/** Numeric ready-state constants used by browser-compatible WebSocket clients. */
export const WebSocketReadyState = {
  CONNECTING: 0,
  OPEN: 1,
  CLOSING: 2,
  CLOSED: 3,
} as const

// Browser-style WebSocket clients may only initiate close with 1000 or 3000-4999.
// Keep protocol/policy close codes on the server side and use an app-defined code here.
/** Client-side close code used for payment protocol errors. */
export const ClientWebSocketProtocolErrorCloseCode = 3008

type EventType = 'close' | 'error' | 'message' | 'open'
type ManagedEventMap = {
  close: { code: number; reason: string; type: 'close'; wasClean: boolean }
  error: { type: 'error' }
  message: { data: string; type: 'message' }
  open: { type: 'open' }
}
type ListenerValue<type extends EventType = EventType> =
  | ((event: ManagedEventMap[type]) => void)
  | { handleEvent(event: ManagedEventMap[type]): void }
type Listener = {
  once: boolean
  value: ListenerValue<EventType>
}
type ManagedSocketShape = {
  onclose: ((event: ManagedEventMap['close']) => void) | null
  onerror: ((event: ManagedEventMap['error']) => void) | null
  onmessage: ((event: ManagedEventMap['message']) => void) | null
  onopen: ((event: ManagedEventMap['open']) => void) | null
}

/** Managed socket facade returned to callers after payment protocol frames are intercepted. */
export type SessionManagedWebSocket = ManagedSocketShape & {
  addEventListener<type extends EventType>(
    type: type,
    listener: ListenerValue<type>,
    options?: boolean | AddEventListenerOptions,
  ): void
  readonly bufferedAmount: WebSocket['bufferedAmount']
  close(code?: number, reason?: string): void
  readonly extensions: WebSocket['extensions']
  on<type extends EventType>(type: type, listener: (event: ManagedEventMap[type]) => void): void
  off<type extends EventType>(type: type, listener: (event: ManagedEventMap[type]) => void): void
  readonly protocol: WebSocket['protocol']
  readonly readyState: WebSocket['readyState']
  removeEventListener<type extends EventType>(type: type, listener: ListenerValue<type>): void
  send(data: string): void
  readonly url: WebSocket['url']
}

/** Wraps a raw WebSocket so protocol frames can be handled before user listeners see messages. */
export function createManagedSocket(socket: WebSocket) {
  const listeners = new Map<EventType, Set<Listener>>()
  let emittedClose = false
  let messageBuffer: ManagedEventMap['message'][] | null = []
  let readyState = socket.readyState

  const add = <type extends EventType>(
    type: type,
    listener: ListenerValue<type>,
    options?: boolean | AddEventListenerOptions,
  ) => {
    let set = listeners.get(type)
    if (!set) {
      set = new Set()
      listeners.set(type, set)
    }
    set.add({
      once: typeof options === 'object' ? options.once === true : false,
      value: listener as ListenerValue<EventType>,
    })
    if (type === 'message' && messageBuffer) {
      const buffered = messageBuffer
      messageBuffer = null
      for (const event of buffered) emit('message', event)
    }
  }

  const remove = <type extends EventType>(type: type, listener: ListenerValue<type>) => {
    const set = listeners.get(type)
    if (!set) return
    for (const entry of set) {
      if (entry.value === listener) set.delete(entry)
    }
  }

  function emit<type extends EventType>(type: type, event: ManagedEventMap[type]) {
    if (event.type === 'close') {
      if (emittedClose) return
      emittedClose = true
      readyState = WebSocketReadyState.CLOSED
      messageBuffer = null
    }
    if (event.type === 'open') readyState = WebSocketReadyState.OPEN

    if (event.type === 'message' && messageBuffer) {
      messageBuffer.push(event)
      return
    }

    switch (event.type) {
      case 'close':
        managed.onclose?.(event)
        break
      case 'error':
        managed.onerror?.(event)
        break
      case 'message':
        managed.onmessage?.(event)
        break
      case 'open':
        managed.onopen?.(event)
        break
    }

    const set = listeners.get(type)
    if (!set) return
    for (const entry of Array.from(set)) {
      if (typeof entry.value === 'function') entry.value(event)
      else entry.value.handleEvent(event)
      if (entry.once) set.delete(entry)
    }
  }

  let onmessage: ManagedSocketShape['onmessage'] = null
  const managed: SessionManagedWebSocket = {
    addEventListener: add,
    close(code?: number, reason?: string) {
      socket.close(code, reason)
    },
    get bufferedAmount() {
      return socket.bufferedAmount
    },
    get extensions() {
      return socket.extensions
    },
    on<type extends EventType>(type: type, listener: (event: ManagedEventMap[type]) => void) {
      add(type, listener)
    },
    onclose: null as ManagedSocketShape['onclose'],
    onerror: null as ManagedSocketShape['onerror'],
    get onmessage() {
      return onmessage
    },
    set onmessage(fn: ManagedSocketShape['onmessage']) {
      onmessage = fn
      if (fn && messageBuffer) {
        const buffered = messageBuffer
        messageBuffer = null
        for (const event of buffered) emit('message', event)
      }
    },
    onopen: null as ManagedSocketShape['onopen'],
    off<type extends EventType>(type: type, listener: (event: ManagedEventMap[type]) => void) {
      remove(type, listener)
    },
    get protocol() {
      return socket.protocol
    },
    get readyState() {
      return readyState
    },
    removeEventListener: remove,
    send(data: string) {
      socket.send(data)
    },
    get url() {
      return socket.url
    },
  }

  return {
    emit,
    socket: managed,
  }
}

/** Top-up requirement emitted by HTTP, SSE, or WebSocket session flows. */
export type TopUpRequirement = {
  /** Challenge used to authorize the management request. */
  challenge: TempoSessionChallenge
  /** Channel that requires more deposit. */
  channelId: Hex.Hex
  /** Current channel deposit in raw units. */
  deposit: bigint
  /** Original paid resource URL; converted to a management URL by the caller. */
  input: RequestInfo | URL
  /** Minimum cumulative voucher amount the server needs. */
  requiredCumulative: bigint
}

/** Inputs needed to validate a caller-requested manager top-up. */
export type ResolveManualTopUpParameters = {
  /** Human-readable or raw top-up amount passed to `SessionManager.topUp()`. */
  amount: string | bigint
  /** Local policy guard for cumulative voucher authorization. */
  assertVoucherWithinLocalLimit(cumulativeAmount: bigint): void
  /** Active channel cache entry, when one exists. */
  channel: ChannelEntry | null
  /** Token decimals used to parse string amounts. */
  decimals: number
  /** Last challenge observed by the manager. */
  lastChallenge: TempoSessionChallenge | null
  /** Last paid resource or management URL available to the manager. */
  lastUrl: RequestInfo | URL | null
}

/** Validated target for a caller-requested manager top-up. */
export type ManualTopUpTarget = {
  /** Additional deposit in raw token units. */
  additionalDeposit: bigint
  /** Challenge used to authorize the top-up credential. */
  challenge: TempoSessionChallenge
  /** Channel ID receiving the top-up. */
  channelId: Hex.Hex
  /** URL used for the top-up management POST. */
  input: RequestInfo | URL
}

/** Inputs for applying a successful top-up POST to local manager state. */
export type ApplyTopUpResultParameters = {
  /** Additional deposit accepted by the top-up credential. */
  additionalDeposit: bigint
  /** Active local channel cache entry, when one exists. */
  channel: ChannelEntry | null
  /** Channel ID targeted by the top-up. */
  channelId: Hex.Hex
  /** Current active challenge ID, used when the server did not return a receipt. */
  challengeId?: string | undefined
  /** Current active machine state, used to preserve paid unit count when possible. */
  currentState: SessionState
  /** Receipt returned by the top-up POST, when present. */
  receipt?: SessionReceipt | undefined
  /** Latest locally observed spend in raw units. */
  spent: bigint
}

/** Local runtime updates produced by a top-up POST. */
export type AppliedTopUpResult = {
  /** Channel with updated deposit. */
  channel: ChannelEntry
  /** Next public machine state, when enough context is available to project one. */
  state?: SessionState | undefined
}

/** Parsed raw-unit amounts from a server need-voucher event. */
export type NeedVoucherEventAmounts = {
  /** Highest voucher amount currently accepted by the server. */
  acceptedCumulative: bigint
  /** Current on-chain deposit reported by the server. */
  deposit: bigint
  /** Minimum cumulative voucher amount required by the server. */
  requiredCumulative: bigint
}

/** Inputs used to satisfy a server need-voucher event. */
export type ResolveNeedVoucherContextParameters = {
  /** Local policy guard for cumulative voucher authorization. */
  assertVoucherWithinLocalLimit(cumulativeAmount: bigint): void
  /** Challenge used for follow-up management credentials. */
  challenge: TempoSessionChallenge
  /** Server need-voucher event. */
  event: NeedVoucherEvent
  /** Expected channel ID for this transport flow. */
  expectedChannelId: Hex.Hex
  /** Reads the latest active channel after any top-up. */
  getChannel(): ChannelEntry | null
  /** Original paid resource URL; converted to management URL by the caller. */
  input: RequestInfo | URL
  /** Performs the deposit top-up when server-required cumulative exceeds deposit. */
  topUpIfNeeded(parameters: TopUpRequirement): Promise<void>
}

/** Result of handling a server need-voucher event. */
export type NeedVoucherResolution =
  | {
      /** A voucher credential can be signed with this context. */
      status: 'ready'
      /** Context passed to the low-level session credential method. */
      context: SessionContext
    }
  | {
      /** No voucher should be sent for this event. */
      status: 'ignored'
      /** Why the event was ignored. */
      reason: 'channel-mismatch' | 'missing-channel'
    }

/** Parses raw-unit numeric fields from a need-voucher event. */
export function readNeedVoucherEventAmounts(event: NeedVoucherEvent): NeedVoucherEventAmounts {
  const amounts = {
    acceptedCumulative: BigInt(event.acceptedCumulative),
    deposit: BigInt(event.deposit),
    requiredCumulative: BigInt(event.requiredCumulative),
  }
  if (amounts.acceptedCumulative > amounts.requiredCumulative) {
    throw new Error('Invalid need-voucher event: accepted cumulative exceeds required cumulative.')
  }
  if (amounts.acceptedCumulative > amounts.deposit) {
    throw new Error('Invalid need-voucher event: accepted cumulative exceeds deposit.')
  }
  return amounts
}

/** Validates local manager state and returns the concrete top-up operation to execute. */
export function resolveManualTopUp(parameters: ResolveManualTopUpParameters): ManualTopUpTarget {
  const { amount, assertVoucherWithinLocalLimit, channel, decimals, lastChallenge, lastUrl } =
    parameters

  if (!channel?.opened) throw new Error('Cannot top up session: no open channel.')
  if (!lastChallenge) {
    throw new Error('Cannot top up session: no challenge available. Make a request first.')
  }
  if (!lastUrl) {
    throw new Error('Cannot top up session: no URL available. Call fetch(), sse(), or ws() first.')
  }

  const additionalDeposit = parseManagerAmount(amount, decimals)
  if (additionalDeposit <= 0n) throw new Error('Top-up amount must be greater than zero.')
  assertVoucherWithinLocalLimit(channel.cumulativeAmount + additionalDeposit)

  return {
    additionalDeposit,
    challenge: lastChallenge,
    channelId: channel.channelId,
    input: lastUrl,
  }
}

/**
 * Applies local deposit and state bookkeeping for a top-up response.
 *
 * `deposit` is updated from the top-up amount. Receipt cumulative values only
 * update accepted spend authorization; they do not replace deposit.
 */
export function applyTopUpResult(
  parameters: ApplyTopUpResultParameters,
): AppliedTopUpResult | undefined {
  const { additionalDeposit, channel, channelId, challengeId, currentState, receipt, spent } =
    parameters
  if (channel?.channelId !== channelId) return undefined
  if (receipt && receipt.channelId !== channelId) return undefined

  const nextDeposit = channel.deposit + additionalDeposit
  const projectedChannel = { ...channel, deposit: nextDeposit }
  const state = receipt
    ? activeStateFromReceipt(receipt, projectedChannel)
    : challengeId
      ? activeStateFromChannel({
          challengeId,
          entry: projectedChannel,
          spent: spent.toString(),
          units: currentState.status === 'active' ? currentState.units : 0,
        })
      : undefined

  channel.deposit = nextDeposit
  if (state) return { channel, state }
  return { channel }
}

/**
 * Applies local top-up/cumulative bookkeeping for a need-voucher event and
 * returns an explicit transport decision.
 */
export async function resolveNeedVoucherContext(
  parameters: ResolveNeedVoucherContextParameters,
): Promise<NeedVoucherResolution> {
  if (parameters.event.channelId !== parameters.expectedChannelId) {
    return { status: 'ignored', reason: 'channel-mismatch' }
  }

  const eventAmounts = readNeedVoucherEventAmounts(parameters.event)
  parameters.assertVoucherWithinLocalLimit(eventAmounts.requiredCumulative)

  await parameters.topUpIfNeeded({
    challenge: parameters.challenge,
    input: parameters.input,
    channelId: parameters.expectedChannelId,
    deposit: eventAmounts.deposit,
    requiredCumulative: eventAmounts.requiredCumulative,
  })

  const channel = parameters.getChannel()
  if (!channel || channel.channelId !== parameters.expectedChannelId) {
    return { status: 'ignored', reason: 'missing-channel' }
  }

  const cumulativeAmount =
    channel.cumulativeAmount > eventAmounts.requiredCumulative
      ? channel.cumulativeAmount
      : uint96(eventAmounts.requiredCumulative)
  channel.cumulativeAmount = cumulativeAmount

  return {
    status: 'ready',
    context: {
      action: 'voucher',
      channelId: parameters.expectedChannelId,
      descriptor: channel.descriptor,
      cumulativeAmountRaw: cumulativeAmount.toString(),
    },
  }
}

/** Canonical challenge shape for built-in `tempo/session` requests. */
export type TempoSessionChallenge = Challenge.Challenge<
  z.output<typeof Methods.session.schema.request>,
  typeof Constants.Intents.session,
  typeof Constants.Methods.tempo
>

/** Creates a credential bound to the current session challenge. */
export type CreateSessionCredential = (
  challenge: TempoSessionChallenge,
  context: SessionContext,
) => Promise<string>

/** Inputs for posting a precompile session top-up credential. */
export type PostTopUpParameters = {
  /** Additional deposit in raw token units. */
  additionalDeposit: bigint
  /** Challenge used to authorize the management request. */
  challenge: TempoSessionChallenge
  /** Local channel expected to receive the top-up. */
  channel: ChannelEntry | null
  /** Channel ID being topped up. */
  channelId: Hex.Hex
  /** Creates the signed top-up credential. */
  createSessionCredential: CreateSessionCredential
  /** Fetch implementation used for the management POST. */
  fetch: typeof globalThis.fetch
  /** Original paid resource URL; normalized to a management URL before posting. */
  input: RequestInfo | URL
}

/** Inputs for retrying an HTTP 402 with a top-up/voucher management round trip. */
export type RetryHttpPaymentRequiredParameters = {
  /** Creates the signed voucher credential. */
  createSessionCredential: CreateSessionCredential
  /** Fetch implementation used for the paid retry. */
  fetch: typeof globalThis.fetch
  /** Returns the current active channel after any top-up side effects. */
  getChannel(): ChannelEntry | null
  /** Original request init used by the paid resource request. */
  init?: RequestInit | undefined
  /** Original paid resource URL. */
  input: RequestInfo | URL
  /** Failed HTTP response that may contain a session challenge. */
  response: Response
  /** Restores local cumulative authorization if the voucher retry fails. */
  restoreCumulative(channelId: Hex.Hex, cumulativeAmount: bigint): void
  /** Stores the selected follow-up challenge on the manager. */
  setChallenge(challenge: TempoSessionChallenge): void
  /** Performs automatic top-up before the voucher retry when deposit is insufficient. */
  topUpIfNeeded(parameters: TopUpRequirement): Promise<void>
}

/** Resolved data needed to perform an automatic HTTP voucher retry. */
export type RetryHttpPaymentContext = {
  /** Channel active before the retry attempt. */
  channel: ChannelEntry
  /** Follow-up challenge selected from the 402 response. */
  challenge: TempoSessionChallenge
  /** Server snapshot describing the required voucher boundary. */
  snapshot: NonNullable<ReturnType<typeof getSessionSnapshot>>
}

/** Inputs for posting a cooperative HTTP close credential. */
export type CloseHttpSessionParameters = {
  /** Creates the signed close credential. */
  createSessionCredential: CreateSessionCredential
  /** Fetch implementation used for the close POST. */
  fetch: typeof globalThis.fetch
  /** Last paid resource URL; used as the management endpoint base. */
  lastUrl: RequestInfo | URL | null
  /** Final cumulative amount the client is willing to sign. */
  signedCloseAmount: string
  /** Stores a fresh close challenge when the first close credential expired. */
  setChallenge?: ((challenge: TempoSessionChallenge) => void) | undefined
  /** Channel/challenge pair being closed. */
  target: CloseTarget
}

/** Returns true when a payment challenge is the built-in `tempo/session` method. */
export function isTempoSessionChallenge(
  challenge: Challenge.Challenge,
): challenge is TempoSessionChallenge {
  return (
    challenge.method === Constants.Methods.tempo && challenge.intent === Constants.Intents.session
  )
}

/** Reads a server-provided session snapshot from challenge method details. */
export function getSessionSnapshot(challenge: TempoSessionChallenge): SessionSnapshot | undefined {
  return Constants.getMethodDetail<SessionSnapshot>(
    challenge.request.methodDetails,
    Constants.MethodDetailKeys.sessionSnapshot,
  )
}

/** Merges request headers and sets the payment authorization header for a retry. */
export function requestInitWithAuthorization(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  credential: string,
): RequestInit {
  const requestHeaders = input instanceof Request ? input.headers : undefined
  return {
    ...init,
    headers: {
      ...Fetch.normalizeHeaders(requestHeaders),
      ...Fetch.normalizeHeaders(init?.headers),
      [Constants.Headers.authorization]: credential,
    },
  }
}

/** Returns the URL used for out-of-band management POSTs, stripping resource query state. */
export function managementInput(input: RequestInfo | URL): RequestInfo | URL {
  try {
    const base =
      typeof location === 'undefined' ? undefined : (location.href as `${string}:${string}`)
    const url =
      input instanceof Request
        ? new URL(input.url)
        : input instanceof URL
          ? new URL(input)
          : new URL(String(input), base)
    url.search = ''
    return url
  } catch {
    return input
  }
}

/** Converts a WebSocket URL into the HTTP URL used for its payment challenge probe. */
export function webSocketProbeUrl(input: string | URL): URL {
  const url = new URL(input.toString())
  if (url.protocol === 'ws:') url.protocol = 'http:'
  if (url.protocol === 'wss:') url.protocol = 'https:'
  return url
}

/** Reads an HTTP problem detail body, falling back to raw text for non-problem responses. */
export async function readProblemDetail(response: Response) {
  const body = await response.text().catch(() => '')
  if (!body) return ''
  if (!response.headers.get('Content-Type')?.includes('application/problem+json')) return body
  try {
    const problem = JSON.parse(body) as { detail?: string }
    return problem.detail ?? body
  } catch {
    return body
  }
}

/** Posts a top-up management credential and returns its receipt, when present. */
export async function postTopUp(
  parameters: PostTopUpParameters,
): Promise<SessionReceipt | undefined> {
  const { channel, channelId } = parameters
  if (!channel?.descriptor || channel.channelId !== channelId) {
    throw new Error('Cannot top up session: no local channel descriptor available.')
  }

  const credential = await parameters.createSessionCredential(parameters.challenge, {
    action: 'topUp',
    channelId,
    descriptor: channel.descriptor,
    additionalDepositRaw: parameters.additionalDeposit.toString(),
  })
  const response = await parameters.fetch(managementInput(parameters.input), {
    method: 'POST',
    headers: { [Constants.Headers.authorization]: credential },
  })
  if (!response.ok) throw new Error(`Top-up POST failed with status ${response.status}`)

  const receiptHeader = response.headers.get(Constants.Headers.paymentReceipt)
  return receiptHeader ? deserializeSessionReceipt(receiptHeader) : undefined
}

/** Retries an HTTP 402 when the server snapshot asks for more voucher headroom. */
export async function retryHttpPaymentRequired(
  parameters: RetryHttpPaymentRequiredParameters,
): Promise<Response | undefined> {
  const context = resolveRetryHttpPaymentContext({
    channel: parameters.getChannel(),
    response: parameters.response,
  })
  if (!context) return undefined
  const { challenge, snapshot } = context

  parameters.setChallenge(challenge)
  const requiredCumulative = BigInt(snapshot.requiredCumulative)

  await parameters.topUpIfNeeded({
    challenge,
    input: parameters.input,
    channelId: snapshot.channelId,
    deposit: BigInt(snapshot.deposit),
    requiredCumulative,
  })

  const currentChannel = parameters.getChannel()
  if (!currentChannel?.descriptor || currentChannel.channelId !== snapshot.channelId) {
    return undefined
  }
  const cumulativeBeforeVoucher = currentChannel.cumulativeAmount
  const cumulativeAmount =
    currentChannel.cumulativeAmount > requiredCumulative
      ? currentChannel.cumulativeAmount
      : requiredCumulative
  const credential = await parameters.createSessionCredential(challenge, {
    action: 'voucher',
    channelId: snapshot.channelId,
    descriptor: currentChannel.descriptor,
    cumulativeAmountRaw: cumulativeAmount.toString(),
  })
  const retry = await parameters.fetch(
    parameters.input,
    requestInitWithAuthorization(parameters.input, parameters.init, credential),
  )
  if (!retry.ok && !retry.headers.get(Constants.Headers.paymentReceipt)) {
    const latestChannel = parameters.getChannel()
    if (
      latestChannel?.channelId === snapshot.channelId &&
      latestChannel.cumulativeAmount <= cumulativeAmount
    ) {
      parameters.restoreCumulative(snapshot.channelId, cumulativeBeforeVoucher)
    }
  }
  return retry
}

/** Resolves whether a 402 response can be handled by an automatic session voucher retry. */
export function resolveRetryHttpPaymentContext(parameters: {
  channel: ChannelEntry | null
  response: Response
}): RetryHttpPaymentContext | undefined {
  const challenge = Challenge.fromResponseList(parameters.response).find(isTempoSessionChallenge)
  if (!challenge) return undefined

  const snapshot = getSessionSnapshot(challenge)
  if (!snapshot) return undefined

  const { channel } = parameters
  if (!channel?.descriptor || channel.channelId !== snapshot.channelId) return undefined

  return { channel, challenge, snapshot }
}

/** Posts a cooperative close credential over HTTP and returns its receipt, when present. */
export async function closeHttpSession(
  parameters: CloseHttpSessionParameters,
): Promise<SessionReceipt | undefined> {
  if (!parameters.lastUrl) {
    throw new Error(
      'Cannot close session: no URL available. This usually means close() was called on a SessionManager instance that was recreated after the session was opened. Use the same SessionManager instance that opened the session, or call fetch()/sse() before close().',
    )
  }

  let currentChallenge = parameters.target.challenge
  const postClose = async (challenge: TempoSessionChallenge) => {
    const credential = await parameters.createSessionCredential(challenge, {
      action: 'close',
      channelId: parameters.target.channelId,
      descriptor: parameters.target.channel.descriptor,
      cumulativeAmountRaw: parameters.signedCloseAmount,
    })
    return parameters.fetch(parameters.lastUrl!, {
      method: 'POST',
      headers: { [Constants.Headers.authorization]: credential },
    })
  }

  let response = await postClose(currentChallenge)
  if (response.status === 402) {
    const challenge = Challenge.fromResponseList(response).find(isTempoSessionChallenge)
    if (challenge) {
      currentChallenge = challenge
      parameters.setChallenge?.(challenge)
      response = await postClose(challenge)
    }
  }
  if (!response.ok) {
    const detail = await readProblemDetail(response)
    const wwwAuth = response.headers.get(Constants.Headers.wwwAuthenticate) ?? ''
    throw new Error(
      `Close request failed with status ${response.status}${detail ? `: ${detail}` : ''}${wwwAuth ? ` [${Constants.Headers.wwwAuthenticate}: ${wwwAuth}]` : ''}`,
    )
  }

  const receiptHeader = response.headers.get(Constants.Headers.paymentReceipt)
  if (!receiptHeader) return undefined
  const receipt = deserializeSessionReceipt(receiptHeader)
  assertHttpCloseReceipt({
    challengeId: currentChallenge.id,
    channelId: parameters.target.channelId,
    expectedCloseAmount: parameters.signedCloseAmount,
    receipt,
  })
  return receipt
}

function assertHttpCloseReceipt(
  parameters: ExpectedSocketReceiptParameters & {
    expectedCloseAmount: string
  },
): void {
  const { challengeId, channelId, expectedCloseAmount, receipt } = parameters
  if (receipt.challengeId !== challengeId || receipt.channelId !== channelId) {
    throw new Error('received mismatched payment-close receipt')
  }
  if (receipt.acceptedCumulative !== expectedCloseAmount || receipt.spent !== expectedCloseAmount) {
    throw new Error('received payment-close receipt for unexpected amount')
  }
}

/** Options accepted by the auto-driving SSE session flow. */
export type SseDriverOptions = RequestInit & {
  /** Called for each payment receipt emitted by the SSE stream. */
  onReceipt?: ((receipt: SessionReceipt) => void) | undefined
  /** Abort signal used to cancel the stream. */
  signal?: AbortSignal | undefined
}

/** Dependencies the SSE driver needs from `SessionManager`. */
export type OpenSseSessionParameters = {
  /** Creates a session credential for the selected challenge/context. */
  createSessionCredential(
    challenge: TempoSessionChallenge,
    context: SessionContext,
  ): Promise<string>
  /** Paid fetch flow used for the initial SSE request and any retry. */
  doFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response>
  /** Fetch implementation used for management voucher posts. */
  fetch: typeof globalThis.fetch
  /** Returns the active channel, if any. */
  getChannel(): ChannelEntry | null
  /** Returns the latest challenge observed by the manager. */
  getChallenge(): TempoSessionChallenge | null
  /** Validates a cumulative amount against local client policy. */
  assertVoucherWithinLocalLimit(cumulativeAmount: bigint): void
  /** Converts a resource URL to the server's session management URL. */
  managementInput(input: RequestInfo | URL): RequestInfo | URL
  /** Applies an incoming receipt to manager state. */
  acceptReceipt(receipt: SessionReceipt): void
  /** Performs an automatic channel top-up when deposit is insufficient. */
  topUpIfNeeded(parameters: TopUpRequirement): Promise<void>
}

/**
 * Opens an auto-driving paid SSE stream.
 *
 * The driver owns only transport parsing and management posts. Session state,
 * credential creation, and top-up policy stay in `SessionManager`.
 */
export async function openSseSession(
  input: RequestInfo | URL,
  init: SseDriverOptions | undefined,
  driver: OpenSseSessionParameters,
): Promise<AsyncIterable<string>> {
  const { onReceipt, signal, ...fetchInit } = init ?? {}
  const sseInit = {
    ...fetchInit,
    headers: {
      ...Fetch.normalizeHeaders(fetchInit.headers),
      Accept: 'text/event-stream',
    },
    ...(signal ? { signal } : {}),
  }

  let response = await driver.doFetch(input, sseInit)
  if (!isEventStream(response) && driver.getChannel()?.opened)
    response = await driver.doFetch(input, sseInit)

  const challenge = driver.getChallenge()
  if (!isEventStream(response)) throw new Error('SSE response is not an event stream.')
  if (!response.body) throw new Error('Response has no body.')

  return iterateSseResponse({
    challenge,
    driver,
    input,
    onReceipt,
    response,
    signal,
  })
}

type IterateSseResponseParameters = {
  challenge: TempoSessionChallenge | null
  driver: OpenSseSessionParameters
  input: RequestInfo | URL
  onReceipt?: ((receipt: SessionReceipt) => void) | undefined
  response: Response
  signal?: AbortSignal | undefined
}

async function* iterateSseResponse(
  parameters: IterateSseResponseParameters,
): AsyncGenerator<string> {
  const reader = parameters.response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      if (parameters.signal?.aborted) break

      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const parts = buffer.split('\n\n')
      buffer = parts.pop()!

      for (const part of parts) {
        if (!part.trim()) continue
        const event = parseEvent(part)
        if (!event) continue

        switch (event.type) {
          case 'message':
            yield event.data
            break
          case 'payment-need-voucher':
            await handleSseNeedVoucher(parameters, event.data)
            break
          case 'payment-receipt':
            parameters.driver.acceptReceipt(event.data)
            parameters.onReceipt?.(event.data)
            break
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

async function handleSseNeedVoucher(
  parameters: IterateSseResponseParameters,
  event: NeedVoucherEvent,
) {
  const channel = parameters.driver.getChannel()
  if (!channel || !parameters.challenge) return

  const resolution = await resolveNeedVoucherContext({
    assertVoucherWithinLocalLimit: parameters.driver.assertVoucherWithinLocalLimit,
    challenge: parameters.challenge,
    event,
    expectedChannelId: channel.channelId,
    getChannel: parameters.driver.getChannel,
    input: parameters.input,
    topUpIfNeeded: parameters.driver.topUpIfNeeded,
  })
  if (resolution.status !== 'ready') return

  const credential = await parameters.driver.createSessionCredential(
    parameters.challenge,
    resolution.context,
  )
  const voucherResponse = await parameters.driver.fetch(
    parameters.driver.managementInput(parameters.input),
    {
      method: 'POST',
      headers: { [Constants.Headers.authorization]: credential },
    },
  )
  if (!voucherResponse.ok) {
    throw new Error(`Voucher POST failed with status ${voucherResponse.status}`)
  }
}

/** Options accepted by the auto-driving WebSocket session flow. */
export type WebSocketDriverOptions = {
  /** Called for each payment receipt emitted by the WebSocket flow. */
  onReceipt?: ((receipt: SessionReceipt) => void) | undefined
  /** WebSocket subprotocols passed to the runtime constructor. */
  protocols?: string | string[] | undefined
  /** Abort signal used to cancel the socket payment flow. */
  signal?: AbortSignal | undefined
}

/** Creates a session credential for a WebSocket payment challenge. */
export type CreateWebSocketCredential = (
  challenge: TempoSessionChallenge,
  context: SessionContext,
) => Promise<string>

/** Inputs for probing and authorizing a paid WebSocket session. */
export type PrepareWebSocketSessionParameters = {
  /** Creates the opening session credential. */
  createSessionCredential: CreateWebSocketCredential
  /** Fetch implementation used for the HTTP 402 probe. */
  fetch: typeof globalThis.fetch
  /** WebSocket URL requested by the caller. */
  input: string | URL
  /** Called after resolving the HTTP probe URL, before the network request. */
  onProbeUrl?: ((httpUrl: URL) => void) | undefined
  /** Optional request init for the HTTP probe. */
  probeInit?: RequestInit | undefined
  /** Optional abort signal applied to the HTTP probe. */
  signal?: AbortSignal | undefined
}

/** Result of the HTTP probe and opening credential creation for a WebSocket session. */
export type PreparedWebSocketSession = {
  /** Selected tempo/session challenge from the HTTP probe. */
  challenge: TempoSessionChallenge
  /** Opening authorization credential to send in-band after the socket opens. */
  credential: string
  /** HTTP URL used for probe and out-of-band management requests. */
  httpUrl: URL
  /** WebSocket URL to open. */
  wsUrl: URL
}

/** Active WebSocket session bookkeeping shared by the manager and socket driver. */
export type ActiveSocketSession = {
  /** Challenge used to create credentials for this socket. */
  challenge: TempoSessionChallenge
  /** Channel authorized by the opening credential. */
  channelId: Hex.Hex
  /** Server close-ready receipt, when the stream is ready to close. */
  closeReadyReceipt: SessionReceipt | null
  /** Number of application chunks delivered through the managed socket. */
  deliveredChunks: bigint
  /** Expected final close amount while a close credential is in flight. */
  expectedCloseAmount: string | null
  /** Raw socket while open; set to null after close. */
  socket: WebSocket | null
  /** Raw token cost per delivered chunk. */
  tickCost: bigint
}

/** Inputs for creating initial WebSocket payment runtime state. */
export type CreateActiveSocketSessionParameters = {
  /** Challenge selected by the HTTP probe. */
  challenge: TempoSessionChallenge
  /** Opening credential sent when the socket opens. */
  credential: string
  /** Raw runtime socket. */
  socket: WebSocket
}

/** Dependencies the WebSocket driver needs from `SessionManager`. */
export type OpenWebSocketSessionParameters = {
  /** Challenge selected by the HTTP probe. */
  challenge: TempoSessionChallenge
  /** Opening credential to send in-band after the socket opens. */
  credential: string
  /** URL used for automatic top-up management calls. */
  httpUrl: URL
  /** WebSocket constructor for the current runtime. */
  WebSocket: WebSocketConstructor
  /** WebSocket URL to open. */
  wsUrl: URL
  /** Optional WebSocket call options. */
  options?: WebSocketDriverOptions | undefined
  /** Creates a session credential for the selected challenge/context. */
  createSessionCredential(
    challenge: TempoSessionChallenge,
    context: SessionContext,
  ): Promise<string>
  /** Returns the active channel, if any. */
  getChannel(): ChannelEntry | null
  /** Stores the active socket state in the manager. */
  setSocketSession(session: ActiveSocketSession): void
  /** Validates a cumulative amount against local client policy. */
  assertVoucherWithinLocalLimit(cumulativeAmount: bigint): void
  /** Applies an incoming receipt to manager state. */
  acceptReceipt(receipt: SessionReceipt): void
  /** Rejects any pending close-ready wait. */
  rejectCloseReady(error: Error): void
  /** Rejects any pending receipt wait. */
  rejectReceipt(error: Error): void
  /** Records a close-ready receipt. */
  settleCloseReady(receipt: SessionReceipt): void
  /** Records a payment receipt. */
  settleReceipt(receipt: SessionReceipt): void
  /** Performs an automatic channel top-up when deposit is insufficient. */
  topUpIfNeeded(parameters: TopUpRequirement): Promise<void>
  /** Waits for the opening receipt before returning the managed socket. */
  waitForReceipt(): Promise<SessionReceipt>
}

/** Inputs for validating a receipt belongs to the active WebSocket payment flow. */
export type ExpectedSocketReceiptParameters = {
  /** Active WebSocket challenge ID. */
  challengeId: string
  /** Active WebSocket channel ID. */
  channelId: Hex.Hex
  /** Receipt received from a WebSocket payment frame. */
  receipt: SessionReceipt
}

/** Inputs for validating a payment-close-ready frame. */
export type ValidateSocketCloseReadyReceiptParameters = ExpectedSocketReceiptParameters & {
  /** Local cumulative voucher authorization for the active channel. */
  cumulativeAmount: bigint
}

/** Inputs for validating a payment-receipt frame. */
export type ValidateSocketPaymentReceiptParameters = ExpectedSocketReceiptParameters & {
  /** Local cumulative voucher authorization for the active channel. */
  cumulativeAmount: bigint
  /** Expected final close amount while a close credential is in flight. */
  expectedCloseAmount: string | null
}

/** Probes a WebSocket endpoint over HTTP and creates the opening credential. */
export async function prepareWebSocketSession(
  parameters: PrepareWebSocketSessionParameters,
): Promise<PreparedWebSocketSession> {
  const wsUrl = new URL(parameters.input.toString())
  const httpUrl = webSocketProbeUrl(wsUrl)
  parameters.onProbeUrl?.(httpUrl)
  const probe = await parameters.fetch(httpUrl, {
    ...parameters.probeInit,
    ...(parameters.signal ? { signal: parameters.signal } : {}),
  })
  if (probe.status !== 402) {
    throw new Error(
      `Expected a 402 payment challenge from ${httpUrl}, received ${probe.status} instead.`,
    )
  }

  const challenge = Challenge.fromResponseList(probe).find(isTempoSessionChallenge)
  if (!challenge) {
    throw new Error(
      'No payment challenge received from HTTP endpoint for this WebSocket URL. The server may not require payment or did not advertise a challenge.',
    )
  }

  return {
    challenge,
    credential: await parameters.createSessionCredential(challenge, {}),
    httpUrl,
    wsUrl,
  }
}

/** Creates the initial runtime state for a paid WebSocket from its opening credential. */
export function createActiveSocketSession(
  parameters: CreateActiveSocketSessionParameters,
): ActiveSocketSession {
  const { challenge, credential, socket } = parameters
  return {
    challenge,
    channelId:
      PaymentCredential.deserialize<SessionCredentialPayload>(credential).payload.channelId,
    closeReadyReceipt: null,
    deliveredChunks: 0n,
    expectedCloseAmount: null,
    socket,
    tickCost: readSessionChallengeAmount(challenge),
  }
}

/** Returns whether a receipt belongs to the active WebSocket session. */
export function isExpectedSocketReceipt(parameters: ExpectedSocketReceiptParameters): boolean {
  const { challengeId, channelId, receipt } = parameters
  return receipt.challengeId === challengeId && receipt.channelId === channelId
}

/** Returns a protocol failure message when a close-ready receipt is invalid. */
export function validateSocketCloseReadyReceipt(
  parameters: ValidateSocketCloseReadyReceiptParameters,
): string | undefined {
  if (!isExpectedSocketReceipt(parameters)) return 'received mismatched payment-close-ready frame'
  if (BigInt(parameters.receipt.spent) > parameters.cumulativeAmount) {
    return 'received payment-close-ready beyond local voucher state'
  }
  return undefined
}

/** Returns a protocol failure message when a payment receipt is invalid. */
export function validateSocketPaymentReceipt(
  parameters: ValidateSocketPaymentReceiptParameters,
): string | undefined {
  const { challengeId, channelId, cumulativeAmount, expectedCloseAmount, receipt } = parameters
  if (!isExpectedSocketReceipt(parameters)) return 'received mismatched payment-receipt frame'
  const acceptedCumulative = BigInt(receipt.acceptedCumulative)
  const spent = BigInt(receipt.spent)
  if (spent > acceptedCumulative) {
    return 'received payment-receipt spent above accepted cumulative'
  }
  if (acceptedCumulative > cumulativeAmount || spent > cumulativeAmount) {
    return 'received payment-receipt beyond local voucher state'
  }
  if (
    expectedCloseAmount !== null &&
    Boolean(receipt.txHash) &&
    !isExpectedCloseReceipt({ challengeId, channelId, expectedCloseAmount, receipt })
  ) {
    return 'received mismatched payment-close receipt frame'
  }
  return undefined
}

/**
 * Opens an auto-driving paid WebSocket session.
 *
 * The driver owns socket protocol frames. Session state, credential creation,
 * and top-up policy remain supplied by `SessionManager`.
 */
export async function openWebSocketSession(
  parameters: OpenWebSocketSessionParameters,
): Promise<SessionManagedWebSocket> {
  const { challenge, credential, options, WebSocket: WebSocketImpl, wsUrl } = parameters
  const rawSocket = new WebSocketImpl(wsUrl, options?.protocols)
  const socketState = createActiveSocketSession({
    challenge,
    credential,
    socket: rawSocket,
  })
  parameters.setSocketSession(socketState)

  const managedSocket = createManagedSocket(rawSocket)
  const failSocketFlow = (message: string) => {
    parameters.rejectReceipt(new Error(message))
    parameters.rejectCloseReady(new Error(message))
    if (
      rawSocket.readyState === WebSocketReadyState.CONNECTING ||
      rawSocket.readyState === WebSocketReadyState.OPEN
    ) {
      rawSocket.close(ClientWebSocketProtocolErrorCloseCode, message)
    }
  }
  rawSocket.addEventListener('close', (event) => {
    socketState.socket = null
    socketState.expectedCloseAmount = null
    parameters.rejectReceipt(new Error('WebSocket closed before the payment flow completed.'))
    parameters.rejectCloseReady(new Error('WebSocket closed before the payment flow completed.'))
    managedSocket.emit('close', {
      code: (event as CloseEvent).code ?? 1000,
      reason: (event as CloseEvent).reason ?? '',
      type: 'close',
      wasClean: true,
    })
  })
  rawSocket.addEventListener('error', () => {
    managedSocket.emit('error', { type: 'error' })
  })
  rawSocket.addEventListener('message', async (event) => {
    const raw = typeof event.data === 'string' ? event.data : undefined
    if (!raw) return
    await handleSocketMessage({
      driver: parameters,
      failSocketFlow,
      managedEmit: managedSocket.emit,
      message: raw,
      rawSocket,
      socketState,
    })
  })
  options?.signal?.addEventListener(
    'abort',
    () => {
      parameters.rejectReceipt(new Error('WebSocket payment flow aborted.'))
      parameters.rejectCloseReady(new Error('WebSocket payment flow aborted.'))
      rawSocket.close()
    },
    { once: true },
  )

  await waitForSocketOpen(rawSocket, managedSocket.emit, wsUrl)
  rawSocket.send(Ws.formatAuthorizationMessage(credential))
  await parameters.waitForReceipt()
  return managedSocket.socket
}

type ManagedEmit = ReturnType<typeof createManagedSocket>['emit']

function waitForSocketOpen(rawSocket: WebSocket, managedEmit: ManagedEmit, wsUrl: URL) {
  return new Promise<void>((resolve, reject) => {
    const onOpen = () => {
      rawSocket.removeEventListener('error', onError)
      managedEmit('open', { type: 'open' })
      resolve()
    }
    const onError = () => {
      rawSocket.removeEventListener('open', onOpen)
      reject(new Error(`WebSocket connection to ${wsUrl} failed to open.`))
    }
    rawSocket.addEventListener('open', onOpen, { once: true })
    rawSocket.addEventListener('error', onError, { once: true })
  })
}

type HandleSocketMessageParameters = {
  driver: OpenWebSocketSessionParameters
  failSocketFlow(message: string): void
  managedEmit: ManagedEmit
  message: string
  rawSocket: WebSocket
  socketState: ActiveSocketSession
}

async function handleSocketMessage(parameters: HandleSocketMessageParameters) {
  const parsed = Ws.parseMessage(parameters.message)
  if (!parsed) {
    parameters.managedEmit('message', { data: parameters.message, type: 'message' })
    return
  }

  switch (parsed.mpp) {
    case 'authorization':
      return
    case 'message':
      parameters.socketState.deliveredChunks += 1n
      parameters.managedEmit('message', { data: parsed.data, type: 'message' })
      return
    case 'payment-close-ready':
      handleCloseReady(parameters, parsed.data)
      return
    case 'payment-error':
      parameters.driver.rejectReceipt(new Error(parsed.message))
      parameters.driver.rejectCloseReady(new Error(parsed.message))
      return
    case 'payment-need-voucher':
      await handleNeedVoucher(parameters, parsed.data)
      return
    case 'payment-receipt':
      handleReceipt(parameters, parsed.data)
      return
  }
}

function handleCloseReady(parameters: HandleSocketMessageParameters, receipt: SessionReceipt) {
  const cumulativeAmount = parameters.driver.getChannel()?.cumulativeAmount ?? 0n
  const error = validateSocketCloseReadyReceipt({
    challengeId: parameters.driver.challenge.id,
    channelId: parameters.socketState.channelId,
    cumulativeAmount,
    receipt,
  })
  if (error) {
    parameters.failSocketFlow(error)
    return
  }
  parameters.driver.acceptReceipt(receipt)
  parameters.driver.options?.onReceipt?.(receipt)
  parameters.driver.settleCloseReady(receipt)
  parameters.managedEmit('close', {
    code: 1000,
    reason: 'stream complete',
    type: 'close',
    wasClean: true,
  })
}

async function handleNeedVoucher(
  parameters: HandleSocketMessageParameters,
  event: NeedVoucherEvent,
) {
  try {
    const resolution = await resolveNeedVoucherContext({
      assertVoucherWithinLocalLimit: parameters.driver.assertVoucherWithinLocalLimit,
      challenge: parameters.driver.challenge,
      event,
      expectedChannelId: parameters.socketState.channelId,
      getChannel: parameters.driver.getChannel,
      input: parameters.driver.httpUrl,
      topUpIfNeeded: parameters.driver.topUpIfNeeded,
    })
    if (resolution.status === 'ignored') {
      parameters.failSocketFlow(
        resolution.reason === 'channel-mismatch'
          ? 'received mismatched payment-need-voucher frame'
          : 'cannot create voucher: no active channel',
      )
      return
    }
    const voucher = await parameters.driver.createSessionCredential(
      parameters.driver.challenge,
      resolution.context,
    )
    parameters.rawSocket.send(Ws.formatAuthorizationMessage(voucher))
  } catch (error) {
    parameters.failSocketFlow(
      error instanceof Error ? error.message : 'failed to create websocket voucher',
    )
  }
}

function handleReceipt(parameters: HandleSocketMessageParameters, receipt: SessionReceipt) {
  const error = validateSocketPaymentReceipt({
    challengeId: parameters.driver.challenge.id,
    channelId: parameters.socketState.channelId,
    cumulativeAmount: parameters.driver.getChannel()?.cumulativeAmount ?? 0n,
    expectedCloseAmount: parameters.socketState.expectedCloseAmount,
    receipt,
  })
  if (error) {
    parameters.failSocketFlow(error)
    return
  }
  parameters.driver.acceptReceipt(receipt)
  parameters.driver.options?.onReceipt?.(receipt)
  parameters.driver.settleReceipt(receipt)
}
