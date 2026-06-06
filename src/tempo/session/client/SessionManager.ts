import type { Hex } from 'ox'
import { isAddressEqual, parseUnits, type Address } from 'viem'

import * as Fetch from '../../../client/internal/Fetch.js'
import * as Constants from '../../../Constants.js'
import type * as Account from '../../../viem/Account.js'
import type * as Client from '../../../viem/Client.js'
import { getAccountSignerAddress } from '../../internal/account.js'
import type { ChannelEntry } from '../client/ChannelOps.js'
import type { SessionContext } from '../client/CredentialState.js'
import { session as sessionPlugin } from '../client/Session.js'
import type { ChannelDescriptor } from '../precompile/Protocol.js'
import { deserializeSessionReceipt } from '../precompile/Protocol.js'
import { readSessionChallengeAmount, type SessionReceipt } from '../precompile/Protocol.js'
import { createSessionReceiptCoordinator } from './ReceiptCoordinator.js'
import { resolveCloseTarget, type CloseTarget } from './Runtime.js'
import { assertVoucherWithinLocalLimit as assertVoucherWithinLocalAuthorization } from './Runtime.js'
import type { SessionState } from './Runtime.js'
import {
  activeStateFromChannel,
  applySessionReceiptToRuntime,
  captureRuntimeSnapshot as captureRuntimeStateSnapshot,
  closedStateFromReceipt,
  computeFallbackCloseAmount,
  createSessionManagerRuntime,
  restoreCumulativeAuthorization,
  restoreRuntimeSnapshot as restoreRuntimeStateSnapshot,
  type RuntimeSnapshot,
} from './Runtime.js'
import { closeSocketSession } from './Runtime.js'
import {
  closeHttpSession,
  getSessionSnapshot,
  isTempoSessionChallenge,
  managementInput,
  postTopUp,
  retryHttpPaymentRequired,
  type TempoSessionChallenge,
  webSocketProbeUrl,
} from './Transports.js'
import {
  type SessionManagedWebSocket,
  type WebSocketConstructor,
  WebSocketReadyState,
} from './Transports.js'
import { openSseSession, type SseDriverOptions } from './Transports.js'
import { applyTopUpResult, resolveManualTopUp, type TopUpRequirement } from './Transports.js'
import {
  openWebSocketSession,
  prepareWebSocketSession,
  type WebSocketDriverOptions,
} from './Transports.js'

export { computeFallbackCloseAmount, type FallbackCloseAmountParameters } from './Runtime.js'

/** Auto-driving client manager for HTTP, SSE, and WebSocket TIP-1034 sessions. */
export type SessionManager = {
  /** Active channel ID, when a channel has been opened or recovered. */
  readonly channelId: Hex.Hex | undefined
  /** Local cumulative voucher authorization in raw token units. */
  readonly cumulative: bigint
  /** Whether the manager currently has an open local channel. */
  readonly opened: boolean
  /** Current pure session state-machine state. */
  readonly state: SessionState

  /** Runs the HTTP 402 probe, signs/open/top-ups as needed, retries, and returns receipt metadata. */
  fetch(input: RequestInfo | URL, init?: RequestInit): Promise<PaymentResponse>
  /** Opens a paid SSE stream and auto-posts vouchers/top-ups when the server requests more headroom. */
  sse(input: RequestInfo | URL, init?: SessionManagerSseOptions): Promise<AsyncIterable<string>>
  /** Opens a paid WebSocket session after an HTTP challenge probe and manages in-band voucher frames. */
  ws(input: string | URL, init?: SessionManagerWebSocketOptions): Promise<SessionManagedWebSocket>
  /** Tops up the active channel deposit. String amounts are parsed with the manager decimals; bigint amounts are raw units. */
  topUp(amount: string | bigint): Promise<SessionReceipt | undefined>
  /** Cooperatively closes the active channel using the latest locally authorized spend boundary. */
  close(): Promise<SessionReceipt | undefined>
}

/** Options for `SessionManager.sse()`. */
export type SessionManagerSseOptions = SseDriverOptions

/** Options for `SessionManager.ws()`. */
export type SessionManagerWebSocketOptions = WebSocketDriverOptions

/** HTTP response enriched with the latest session payment metadata. */
export type PaymentResponse = Response & {
  /** Parsed payment receipt, when the response included one. */
  receipt: SessionReceipt | null
  /** Last session challenge observed by the manager. */
  challenge: TempoSessionChallenge | null
  /** Active channel ID, when available. */
  channelId: Hex.Hex | null
  /** Local cumulative voucher authorization in raw token units. */
  cumulative: bigint
}

/** Serializable client-side channel snapshot stored between manager instances. */
export type StoredSessionChannel = {
  /** Latest known channel ID. Used as the next request's channel hint. */
  channelId: Hex.Hex
  /** Latest local cumulative voucher authorization in raw token units. */
  cumulativeAmount: string
  /** Latest known deposit in raw token units. */
  deposit: string
  /** TIP-1034 channel descriptor, used as a fallback when the server cannot snapshot. */
  descriptor: ChannelDescriptor
  /** Escrow address used to derive the channel ID. */
  escrow: Address
  /** Chain ID used to derive the channel ID. */
  chainId: number
  /** Whether the channel was open when stored. Closed channels are not used as hints. */
  opened: boolean
  /** Client timestamp for debugging or app-level eviction. */
  updatedAt: number
}

/** Transport currently resolving an optional persistent session cache key. */
export type SessionKeyTransport = 'fetch' | 'sse' | 'ws'

/** Inputs used to compute an optional persistent session cache key. */
export type SessionKeyContext = {
  /** Root account address that owns the channel. */
  account: Address
  /** Address authorized to sign vouchers for the channel. */
  authorizedSigner: Address
  /** Origin of the paid endpoint being accessed. */
  origin: string
  /** Original paid endpoint input. */
  input: RequestInfo | URL | string
  /** Transport currently opening or reusing a session. */
  transport: SessionKeyTransport
}

/** Resolves the persistent session cache key for a manager operation. */
export type SessionKey = string | ((context: SessionKeyContext) => string)

/** Optional per-manager store for channel hints and restart recovery. */
export type SessionStore = {
  /** Reads the latest stored channel snapshot for the supplied cache key. */
  get(
    key: string,
  ): Promise<StoredSessionChannel | null | undefined> | StoredSessionChannel | null | undefined
  /** Persists the latest channel snapshot under the supplied cache key. */
  set(key: string, channel: StoredSessionChannel): Promise<void> | void
  /** Deletes the stored snapshot when a channel is closed, when supported. */
  delete?(key: string): Promise<void> | void
}

/** Normalized runtime dependencies derived from `sessionManager()` parameters. */
type SessionManagerConfig = {
  /** Decimal precision used when parsing human-readable manager amounts. */
  decimals: number
  /** Fetch implementation used for probes, retries, and management posts. */
  fetch: typeof globalThis.fetch
  /** Local maximum cumulative voucher authorization, or null when uncapped. */
  maxVoucherCumulative: bigint | null
  /** Optional persistent session cache key override. */
  sessionKey: SessionKey | undefined
  /** WebSocket constructor available in the current runtime, when configured. */
  WebSocket: WebSocketConstructor | undefined
}

function storedChannelFromEntry(entry: ChannelEntry): StoredSessionChannel {
  return {
    channelId: entry.channelId,
    cumulativeAmount: entry.cumulativeAmount.toString(),
    deposit: entry.deposit.toString(),
    descriptor: entry.descriptor,
    escrow: entry.escrow,
    chainId: entry.chainId,
    opened: entry.opened,
    updatedAt: Date.now(),
  }
}

function storedChannelContext(channel: StoredSessionChannel): SessionContext {
  return {
    channelId: channel.channelId,
    cumulativeAmountRaw: channel.cumulativeAmount,
    descriptor: channel.descriptor,
  }
}

function resolveSessionKeyIdentity(parameters: sessionManager.Parameters):
  | {
      account: Address
      authorizedSigner: Address
    }
  | undefined {
  const account = parameters.account ?? parameters.client?.account
  if (!account) return undefined
  if (typeof account === 'string') {
    return {
      account,
      authorizedSigner: parameters.authorizedSigner ?? account,
    }
  }
  const signer = parameters.authorizedSigner ?? getAccountSignerAddress(account)
  return {
    account: account.address,
    authorizedSigner: signer,
  }
}

function inputOrigin(input: RequestInfo | URL | string): string {
  const base =
    typeof location === 'undefined' ? undefined : (location.href as `${string}:${string}`)
  const raw =
    input instanceof Request ? input.url : input instanceof URL ? input.href : String(input)
  try {
    return new URL(raw, base).origin
  } catch {
    throw new Error(
      'Cannot derive a default session cache key for this input. Pass sessionKey to sessionManager().',
    )
  }
}

function defaultSessionKey(context: SessionKeyContext): string {
  return `mppx:tempo-session:${context.origin}:${context.account.toLowerCase()}:${context.authorizedSigner.toLowerCase()}`
}

function resolveSessionStoreKey(parameters: {
  identity: Pick<SessionKeyContext, 'account' | 'authorizedSigner'> | undefined
  input: RequestInfo | URL | string
  sessionKey: SessionKey | undefined
  transport: SessionKeyTransport
}): string {
  if (typeof parameters.sessionKey === 'string') return parameters.sessionKey
  if (!parameters.identity) {
    throw new Error(
      'Cannot derive a default session cache key without a synchronously resolvable account. Pass account, client.account, or a string sessionKey to sessionManager().',
    )
  }
  const context = {
    ...parameters.identity,
    input: parameters.input,
    origin: inputOrigin(parameters.input),
    transport: parameters.transport,
  } satisfies SessionKeyContext
  return parameters.sessionKey ? parameters.sessionKey(context) : defaultSessionKey(context)
}

function maybeAddress(value: unknown): Address | undefined {
  return typeof value === 'string' ? (value as Address) : undefined
}

function storedChannelMatchesIdentity(
  channel: StoredSessionChannel,
  identity: Pick<SessionKeyContext, 'account' | 'authorizedSigner'>,
): boolean {
  return (
    isAddressEqual(channel.descriptor.payer, identity.account) &&
    isAddressEqual(channel.descriptor.authorizedSigner, identity.authorizedSigner)
  )
}

function storedChannelMatchesChallenge(
  channel: StoredSessionChannel,
  challenge: TempoSessionChallenge,
): boolean {
  const details = challenge.request.methodDetails
  const chainId = typeof details?.chainId === 'number' ? details.chainId : undefined
  const escrow = maybeAddress(details?.escrowContract)
  const recipient = maybeAddress(challenge.request.recipient)
  const currency = maybeAddress(challenge.request.currency)

  if (chainId !== undefined && channel.chainId !== chainId) return false
  if (escrow && !isAddressEqual(channel.escrow, escrow)) return false
  if (recipient && !isAddressEqual(channel.descriptor.payee, recipient)) return false
  if (currency && !isAddressEqual(channel.descriptor.token, currency)) return false
  return true
}

function requestInitWithSessionHint(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  channelId: Hex.Hex | undefined,
): RequestInit | undefined {
  if (!channelId) return init
  const requestHeaders = input instanceof Request ? input.headers : undefined
  const headers = {
    ...Fetch.normalizeHeaders(requestHeaders),
    ...Fetch.normalizeHeaders(init?.headers),
  }
  if (
    Object.keys(headers).some(
      (key) => key.toLowerCase() === Constants.Headers.paymentSession.toLowerCase(),
    )
  )
    return init
  return {
    ...init,
    headers: {
      ...headers,
      [Constants.Headers.paymentSession]: channelId,
    },
  }
}

function resolveSessionManagerConfig(parameters: sessionManager.Parameters): SessionManagerConfig {
  const decimals = parameters.decimals ?? 6
  const WebSocket =
    parameters.webSocket ??
    (globalThis as typeof globalThis & { WebSocket?: WebSocketConstructor }).WebSocket

  return {
    decimals,
    fetch: parameters.fetch ?? globalThis.fetch,
    maxVoucherCumulative:
      parameters.maxDeposit !== undefined ? parseUnits(parameters.maxDeposit, decimals) : null,
    sessionKey: parameters.sessionKey,
    WebSocket,
  }
}

/**
 * Creates a session manager that handles the full client payment lifecycle:
 * channel open, incremental vouchers, SSE streaming, and channel close.
 *
 * Internally delegates to the `session()` method for all
 * channel state management and credential creation, and to `Fetch.from`
 * for the 402 challenge/retry flow.
 *
 * ## Session resumption
 *
 * The manager only keeps active client transport state in memory. Channel
 * descriptors and cumulative voucher state are hydrated from server snapshots
 * when challenges include them; otherwise the next request opens a fresh
 * TIP-1034 channel. `maxDeposit` remains the local cap for all automatic
 * voucher and top-up decisions.
 */
export function sessionManager(parameters: sessionManager.Parameters): SessionManager {
  const config = resolveSessionManagerConfig(parameters)
  const sessionStore = parameters.sessionStore
  const sessionKeyIdentity = sessionStore ? resolveSessionKeyIdentity(parameters) : undefined
  let activeStoreKey: string | null = null
  let storedChannel: StoredSessionChannel | null = null
  let storedChannelKey: string | null = null
  const runtime = createSessionManagerRuntime()
  const receipts = createSessionReceiptCoordinator({
    getSocketSession: () => runtime.socketSession,
  })

  const method = sessionPlugin({
    account: parameters.account,
    authorizedSigner: parameters.authorizedSigner,
    getClient: parameters.client ? () => parameters.client! : parameters.getClient,
    escrow: parameters.escrow,
    decimals: config.decimals,
    maxDeposit: parameters.maxDeposit,
    onChannelUpdate(entry) {
      if (entry.channelId !== runtime.channel?.channelId) runtime.spent = 0n
      runtime.channel = entry
      persistStoredChannel(entry)
      if (runtime.lastChallenge) {
        runtime.state = activeStateFromChannel({
          challengeId: runtime.lastChallenge.id,
          entry,
          spent: runtime.spent.toString(),
          units: 0,
        })
      }
    },
  })

  const wrappedFetch = Fetch.from({
    fetch: config.fetch,
    methods: [method],
    onChallenge: async (challenge, _helpers) => {
      if (!isTempoSessionChallenge(challenge)) return undefined
      runtime.lastChallenge = challenge
      runtime.state = { status: 'challenged', challengeId: challenge.id }
      if (runtime.channel?.opened && runtime.lastUrl) {
        const requiredCumulative =
          runtime.channel.cumulativeAmount + readSessionChallengeAmount(challenge)
        await topUpIfNeeded({
          challenge,
          input: runtime.lastUrl,
          channelId: runtime.channel.channelId,
          deposit: runtime.channel.deposit,
          requiredCumulative,
        })
      }
      if (
        !runtime.channel?.opened &&
        storedChannel?.opened &&
        storedChannelMatchesChallenge(storedChannel, challenge) &&
        !getSessionSnapshot(challenge)
      ) {
        return _helpers.createCredential(storedChannelContext(storedChannel))
      }
      return undefined
    },
  })

  function createSessionCredential(challenge: TempoSessionChallenge, context: SessionContext) {
    const stored = storedChannel
    const shouldUseStoredChannel =
      !context.action &&
      !runtime.channel?.opened &&
      stored?.opened &&
      storedChannelMatchesChallenge(stored, challenge) &&
      !getSessionSnapshot(challenge)
    return method.createCredential({
      challenge,
      context: shouldUseStoredChannel ? { ...context, ...storedChannelContext(stored) } : context,
    })
  }

  function updateSpentFromReceipt(receipt: SessionReceipt | null | undefined) {
    applySessionReceiptToRuntime({
      maxVoucherCumulative: config.maxVoucherCumulative,
      receipt,
      runtime,
    })
  }

  function resolveActiveStoreKey(
    input: RequestInfo | URL | string,
    transport: SessionKeyTransport,
  ) {
    if (!sessionStore) return null
    if (activeStoreKey && runtime.channel?.opened) return activeStoreKey
    activeStoreKey = resolveSessionStoreKey({
      identity: sessionKeyIdentity,
      input,
      sessionKey: config.sessionKey,
      transport,
    })
    return activeStoreKey
  }

  async function getStoredChannel(
    input: RequestInfo | URL | string,
    transport: SessionKeyTransport,
  ) {
    if (!sessionStore) return null
    const key = resolveActiveStoreKey(input, transport)
    if (!key) return null
    if (storedChannelKey === key) return storedChannel
    const channel = await sessionStore.get(key)
    storedChannel =
      channel?.opened &&
      (!sessionKeyIdentity || storedChannelMatchesIdentity(channel, sessionKeyIdentity))
        ? channel
        : null
    storedChannelKey = key
    return storedChannel
  }

  function persistStoredChannel(entry: ChannelEntry) {
    if (!sessionStore || !activeStoreKey) return
    const channel = storedChannelFromEntry(entry)
    const operation =
      entry.opened || !sessionStore.delete
        ? sessionStore.set(activeStoreKey, channel)
        : sessionStore.delete(activeStoreKey)
    void Promise.resolve(operation).catch(() => undefined)
    storedChannel = entry.opened ? channel : null
    storedChannelKey = activeStoreKey
  }

  function getFallbackCloseAmount(challenge: TempoSessionChallenge, channelId: Hex.Hex): bigint {
    const currentSocket = runtime.socketSession
    return computeFallbackCloseAmount({
      challengeId: challenge.id,
      channelId,
      closeReadyReceipt: currentSocket?.closeReadyReceipt,
      cumulativeAmount:
        runtime.channel?.channelId === channelId ? runtime.channel.cumulativeAmount : 0n,
      deliveredChunks: currentSocket?.deliveredChunks,
      socketChallengeId: currentSocket?.challenge.id,
      socketChannelId: currentSocket?.channelId,
      spent: runtime.spent,
      tickCost: currentSocket?.tickCost,
    })
  }

  function getValidatedFallbackCloseAmount(target: CloseTarget) {
    const closeAmount = getFallbackCloseAmount(target.challenge, target.channelId)
    if (closeAmount > target.channel.cumulativeAmount) {
      throw new Error('fallback close amount exceeds local voucher state')
    }
    assertVoucherWithinLocalLimit(closeAmount)
    return closeAmount.toString()
  }

  function assertVoucherWithinLocalLimit(cumulativeAmount: bigint) {
    assertVoucherWithinLocalAuthorization({
      cumulativeAmount,
      maxVoucherCumulative: config.maxVoucherCumulative,
    })
  }

  async function postTopUpAndApply(parameters: {
    additionalDeposit: bigint
    challenge: TempoSessionChallenge
    channelId: Hex.Hex
    input: RequestInfo | URL
  }) {
    const receipt = await postTopUp({
      ...parameters,
      channel: runtime.channel,
      createSessionCredential,
      fetch: config.fetch,
    })
    updateSpentFromReceipt(receipt)
    const applied = applyTopUpResult({
      additionalDeposit: parameters.additionalDeposit,
      channel: runtime.channel,
      channelId: parameters.channelId,
      challengeId: runtime.lastChallenge?.id,
      currentState: runtime.state,
      receipt,
      spent: runtime.spent,
    })
    if (applied?.state) runtime.state = applied.state
    return receipt
  }

  async function topUpIfNeeded(parameters: TopUpRequirement) {
    if (parameters.requiredCumulative <= parameters.deposit) return
    assertVoucherWithinLocalLimit(parameters.requiredCumulative)
    await postTopUpAndApply({
      challenge: parameters.challenge,
      input: parameters.input,
      channelId: parameters.channelId,
      additionalDeposit: parameters.requiredCumulative - parameters.deposit,
    })
  }

  function restoreCumulative(channelId: Hex.Hex, cumulativeAmount: bigint) {
    const restored = restoreCumulativeAuthorization({
      channel: runtime.channel,
      channelId,
      challengeId: runtime.lastChallenge?.id,
      cumulativeAmount,
      spent: runtime.spent,
      state: runtime.state,
    })
    if (restored) runtime.state = restored
  }

  function restoreRuntime(snapshot: RuntimeSnapshot) {
    const restored = restoreRuntimeStateSnapshot(snapshot, runtime.channel)
    runtime.channel = restored.channel
    runtime.spent = restored.spent
    runtime.state = restored.state
  }

  function toPaymentResponse(response: Response): PaymentResponse {
    const receiptHeader = response.headers.get(Constants.Headers.paymentReceipt)
    const receipt = receiptHeader ? deserializeSessionReceipt(receiptHeader) : null
    updateSpentFromReceipt(receipt)
    return Object.assign(response, {
      receipt,
      challenge: runtime.lastChallenge,
      channelId: runtime.channel?.channelId ?? null,
      cumulative: runtime.channel?.cumulativeAmount ?? 0n,
    })
  }

  async function doFetch(
    input: RequestInfo | URL,
    init?: RequestInit,
    transport: SessionKeyTransport = 'fetch',
  ): Promise<PaymentResponse> {
    runtime.lastUrl = input
    const stored = await getStoredChannel(input, transport)
    const hintedInit = requestInitWithSessionHint(input, init, stored?.channelId)
    const previous = captureRuntimeStateSnapshot({
      channel: runtime.channel,
      spent: runtime.spent,
      state: runtime.state,
    })

    let response: Response
    try {
      response = await wrappedFetch(input, hintedInit)
    } catch (error) {
      restoreRuntime(previous)
      throw error
    }
    let paymentResponse = toPaymentResponse(response)
    let attemptedHttpManagement = false
    if (paymentResponse.status === 402) {
      const retry = await retryHttpPaymentRequired({
        input,
        init: hintedInit,
        response: paymentResponse,
        createSessionCredential,
        fetch: config.fetch,
        getChannel: () => runtime.channel,
        restoreCumulative,
        setChallenge(challenge) {
          runtime.lastChallenge = challenge
        },
        topUpIfNeeded,
      })
      if (retry) {
        attemptedHttpManagement = true
        paymentResponse = toPaymentResponse(retry)
      }
    }
    if (!attemptedHttpManagement && !paymentResponse.ok && !paymentResponse.receipt)
      restoreRuntime(previous)
    return paymentResponse
  }

  async function closeHttpSessionAndApply(
    target: CloseTarget,
  ): Promise<SessionReceipt | undefined> {
    const receipt = await closeHttpSession({
      createSessionCredential,
      fetch: config.fetch,
      lastUrl: runtime.lastUrl,
      signedCloseAmount: getValidatedFallbackCloseAmount(target),
      setChallenge(challenge) {
        runtime.lastChallenge = challenge
      },
      target,
    })
    if (receipt) {
      runtime.state = closedStateFromReceipt(receipt, target.channel)
    }

    return receipt
  }

  const self: SessionManager = {
    get channelId() {
      return runtime.channel?.channelId
    },
    get cumulative() {
      return runtime.channel?.cumulativeAmount ?? 0n
    },
    get opened() {
      return runtime.channel?.opened ?? false
    },
    get state() {
      return runtime.state
    },

    fetch: (input, init) => doFetch(input, init, 'fetch'),

    async topUp(amount) {
      const target = resolveManualTopUp({
        amount,
        assertVoucherWithinLocalLimit,
        channel: runtime.channel,
        decimals: config.decimals,
        lastChallenge: runtime.lastChallenge,
        lastUrl: runtime.lastUrl,
      })

      return postTopUpAndApply({
        additionalDeposit: target.additionalDeposit,
        challenge: target.challenge,
        channelId: target.channelId,
        input: target.input,
      })
    },

    async sse(input, init) {
      return openSseSession(input, init, {
        createSessionCredential,
        doFetch: (probeInput, probeInit) => doFetch(probeInput, probeInit, 'sse'),
        fetch: config.fetch,
        getChannel: () => runtime.channel,
        getChallenge: () => runtime.lastChallenge,
        assertVoucherWithinLocalLimit,
        managementInput,
        acceptReceipt(receipt) {
          updateSpentFromReceipt(receipt)
        },
        topUpIfNeeded,
      })
    },

    async ws(input, init) {
      if (!config.WebSocket) {
        throw new Error(
          'No WebSocket implementation available. Pass `webSocket` to sessionManager() in this runtime.',
        )
      }

      const prepared = await prepareWebSocketSession({
        createSessionCredential,
        fetch: config.fetch,
        input,
        onProbeUrl(httpUrl) {
          runtime.lastUrl = httpUrl.toString()
        },
        probeInit: requestInitWithSessionHint(
          webSocketProbeUrl(input),
          init?.signal ? { signal: init.signal } : undefined,
          (await getStoredChannel(input, 'ws'))?.channelId,
        ),
        signal: init?.signal,
      })
      const { challenge, credential, httpUrl, wsUrl } = prepared
      runtime.lastChallenge = challenge

      return openWebSocketSession({
        challenge,
        credential,
        httpUrl,
        WebSocket: config.WebSocket,
        wsUrl,
        options: init,
        createSessionCredential,
        getChannel: () => runtime.channel,
        setSocketSession(session) {
          runtime.socketSession = session
        },
        assertVoucherWithinLocalLimit,
        acceptReceipt: updateSpentFromReceipt,
        rejectCloseReady: receipts.rejectCloseReady,
        rejectReceipt: receipts.rejectReceipt,
        settleCloseReady: receipts.settleCloseReady,
        settleReceipt: receipts.settleReceipt,
        topUpIfNeeded,
        waitForReceipt: receipts.waitForReceipt,
      })
    },

    async close() {
      const currentSocket = runtime.socketSession
      const target = resolveCloseTarget({
        channel: runtime.channel,
        currentSocket,
        lastChallenge: runtime.lastChallenge,
      })
      if (!target) return undefined

      const previous = captureRuntimeStateSnapshot({
        channel: runtime.channel,
        spent: runtime.spent,
        state: runtime.state,
      })
      const activeSocket = currentSocket?.socket
      try {
        if (currentSocket && activeSocket?.readyState === WebSocketReadyState.OPEN) {
          const receipt = await closeSocketSession({
            activeSocket,
            createSessionCredential,
            currentSocket,
            spent: runtime.spent,
            target,
            waitForCloseReady: receipts.waitForCloseReady,
            waitForReceipt: receipts.waitForReceipt,
          })
          runtime.state = closedStateFromReceipt(receipt, target.channel)
          persistStoredChannel({ ...target.channel, opened: false })
          return receipt
        }

        const receipt = await closeHttpSessionAndApply(target)
        if (receipt) persistStoredChannel({ ...target.channel, opened: false })
        return receipt
      } catch (error) {
        restoreRuntime(previous)
        throw error
      }
    },
  }

  return self
}

/** Type helpers for `sessionManager()`. */
export declare namespace sessionManager {
  type Parameters = Account.getResolver.Parameters &
    Client.getResolver.Parameters & {
      /** Address authorized to sign vouchers. Defaults to the account access key address when available, otherwise the account address. */
      authorizedSigner?: Address | undefined
      /** Viem client instance. Shorthand for `getClient: () => client`. */
      client?: import('viem').Client | undefined
      /** Token decimals used to convert `maxDeposit` to raw units. Defaults to `6`. */
      decimals?: number | undefined
      /** TIP20EscrowChannel precompile address override. */
      escrow?: Address | undefined
      /** Fetch implementation used for HTTP probes, management posts, and paid retries. */
      fetch?: typeof globalThis.fetch | undefined
      /** Maximum deposit in human-readable units (e.g. `'10'` for 10 tokens). Converted to raw units via `decimals`. */
      maxDeposit?: string | undefined
      /** Optional per-manager store for persisted channel hints and restart recovery. */
      sessionStore?: SessionStore | undefined
      /** Optional persistent session cache key override. Defaults to origin + account + signer. */
      sessionKey?: SessionKey | undefined
      /** Optional websocket constructor for runtimes without a global WebSocket. */
      webSocket?: WebSocketConstructor | undefined
    }
}
