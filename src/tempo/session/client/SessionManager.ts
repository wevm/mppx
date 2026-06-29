import type { Hex } from 'ox'
import { parseUnits, type Address } from 'viem'

import * as Challenge from '../../../Challenge.js'
import * as Fetch from '../../../client/internal/Fetch.js'
import * as Constants from '../../../Constants.js'
import type * as Account from '../../../viem/Account.js'
import type * as Client from '../../../viem/Client.js'
import { charge as chargePlugin } from '../../client/Charge.js'
import type { ChannelEntry } from '../client/ChannelOps.js'
import { createChannelStore, entryKey, type ChannelStore } from '../client/ChannelStore.js'
import type { SessionContext } from '../client/CredentialState.js'
import { session as sessionPlugin } from '../client/Session.js'
import { deserializeSessionReceipt } from '../precompile/Protocol.js'
import { readSessionChallengeAmount, type SessionReceipt } from '../precompile/Protocol.js'
import {
  deserializeSnapshot as deserializeSessionSnapshot,
  serializeSnapshot as serializeSessionSnapshot,
} from '../Snapshot.js'
import { createSessionReceiptCoordinator } from './ReceiptCoordinator.js'
import { resolveCloseTarget, type CloseTarget } from './Runtime.js'
import { assertVoucherWithinLocalLimit as assertVoucherWithinLocalAuthorization } from './Runtime.js'
import type { SessionState } from './Runtime.js'
import {
  applySessionReceiptToRuntime,
  captureRuntimeSnapshot as captureRuntimeStateSnapshot,
  computeFallbackCloseAmount,
  createSessionManagerRuntime,
  dispatchSessionEvent,
  restoreCumulativeAuthorization,
  restoreRuntimeSnapshot as restoreRuntimeStateSnapshot,
  type RuntimeSnapshot,
} from './Runtime.js'
import { closeSocketSession } from './Runtime.js'
import {
  closeHttpSession,
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

/** Normalized runtime dependencies derived from `sessionManager()` parameters. */
type SessionManagerConfig = {
  /** Decimal precision used when parsing human-readable manager amounts. */
  decimals: number
  /** Fetch implementation used for probes, retries, and management posts. */
  fetch: typeof globalThis.fetch
  /** Local maximum cumulative voucher authorization, or null when uncapped. */
  maxVoucherCumulative: bigint | null
  /** WebSocket constructor available in the current runtime, when configured. */
  WebSocket: WebSocketConstructor | undefined
}

function isTempoChargeChallenge(challenge: Challenge.Challenge) {
  return (
    challenge.method === Constants.Methods.tempo && challenge.intent === Constants.Intents.charge
  )
}

function isZeroAmountChargeChallenge(challenge: Challenge.Challenge) {
  if (!isTempoChargeChallenge(challenge)) return false
  if (typeof challenge.request.amount !== 'string') return false
  try {
    return BigInt(challenge.request.amount) === 0n
  } catch {
    return false
  }
}

/** Builds a reusable channel entry from a server session snapshot header. */
function entryFromSnapshot(snapshot: ReturnType<typeof deserializeSessionSnapshot>): ChannelEntry {
  return {
    channelId: snapshot.channelId,
    cumulativeAmount: BigInt(snapshot.acceptedCumulative),
    deposit: BigInt(snapshot.deposit),
    descriptor: snapshot.descriptor,
    escrow: snapshot.escrow,
    chainId: snapshot.chainId,
    opened: true,
  }
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
    fetch: parameters.fetch ?? globalThis.fetch.bind(globalThis),
    maxVoucherCumulative:
      parameters.maxDeposit !== undefined ? parseUnits(parameters.maxDeposit, decimals) : null,
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
 * `channelStore` can persist reusable channels between manager instances.
 */
export function sessionManager(parameters: sessionManager.Parameters): SessionManager {
  const config = resolveSessionManagerConfig(parameters)
  const runtime = createSessionManagerRuntime()
  const receipts = createSessionReceiptCoordinator({
    getSocketSession: () => runtime.socketSession,
  })

  const backing = parameters.channelStore ?? createChannelStore()
  const ignoredChannelIds = new Set<Hex.Hex>()

  // Tracks one fetch's channel reuse so stale stored entries can be evicted once.
  type ChannelUse = {
    challengesReceived: number
    created: Map<string, ChannelEntry>
    seenExisting: Set<string>
    previous: RuntimeSnapshot
    resumed: ChannelEntry | undefined
    trackCreates: boolean
  }
  let channelUse: ChannelUse | undefined

  /** Returns the backing entry for `key` only when it is open and not ignored. */
  async function getReusable(key: string): Promise<ChannelEntry | undefined> {
    const entry = await backing.get(key)
    if (entry?.opened && !ignoredChannelIds.has(entry.channelId)) return entry
    return undefined
  }

  const store: ChannelStore = {
    async get(key) {
      const entry = await getReusable(key)
      if (entry && channelUse) {
        channelUse.seenExisting.add(key)
        if (!channelUse.created.has(key)) channelUse.resumed ??= entry
      }
      return entry
    },
    async set(entry) {
      const key = entryKey(entry)
      if (entry.opened) ignoredChannelIds.delete(entry.channelId)
      if (channelUse?.trackCreates && !channelUse.seenExisting.has(key))
        channelUse.created.set(key, entry)
      await backing.set(entry)
    },
    delete: (key) => backing.delete(key),
  }

  /** Removes a failed channel from candidacy for the rest of this manager's life. */
  async function ignoreChannel(entry: ChannelEntry) {
    ignoredChannelIds.add(entry.channelId)
    await Promise.resolve(backing.delete(entryKey(entry))).catch(() => undefined)
  }

  async function rollbackCreatedChannelsForRetry() {
    const use = channelUse
    if (!use?.created.size) return
    for (const [key, entry] of use.created) {
      ignoredChannelIds.add(entry.channelId)
      await Promise.resolve(backing.delete(key)).catch(() => undefined)
    }
    use.created.clear()
    restoreRuntime(use.previous)
  }

  function referencesCreatedChannel(challenge: Challenge.Challenge): boolean {
    const snapshot = Constants.getMethodDetail<{ channelId?: unknown }>(
      challenge.request.methodDetails,
      Constants.MethodDetailKeys.sessionSnapshot,
    )
    if (typeof snapshot?.channelId !== 'string') return false
    const use = channelUse
    if (!use?.created.size) return false
    for (const entry of use.created.values()) {
      if (entry.channelId.toLowerCase() === snapshot.channelId.toLowerCase()) return true
    }
    return false
  }

  function dispatch(event: Parameters<typeof dispatchSessionEvent>[1]) {
    return dispatchSessionEvent(runtime, event)
  }

  const method = sessionPlugin({
    account: parameters.account,
    getClient: parameters.client ? () => parameters.client! : parameters.getClient,
    escrow: parameters.escrow,
    decimals: config.decimals,
    maxDeposit: parameters.maxDeposit,
    channelStore: store,
    onChannelUpdate(entry) {
      if (entry.channelId !== runtime.channel?.channelId) runtime.spent = 0n
      runtime.channel = entry
      if (runtime.lastChallenge) {
        dispatch({
          type: 'activated',
          challengeId: runtime.lastChallenge.id,
          entry,
          spent: runtime.spent.toString(),
          units: 0,
        })
      }
    },
  })
  const chargeMethod = chargePlugin({
    account: parameters.account,
    getClient: parameters.client ? () => parameters.client! : parameters.getClient,
  })

  const wrappedFetch = Fetch.from({
    fetch: config.fetch,
    methods: [method],
    onChallenge: async (challenge, _helpers) => {
      if (!isTempoSessionChallenge(challenge)) return undefined
      const use = channelUse
      const isRepeatedRetryChallenge =
        use && use.challengesReceived > 0 && challenge.id === runtime.lastChallenge?.id
      if (!referencesCreatedChannel(challenge)) {
        if (use?.created.size) await rollbackCreatedChannelsForRetry()
        else if (isRepeatedRetryChallenge) restoreRuntime(use.previous)
      }
      if (use) use.challengesReceived++
      runtime.lastChallenge = challenge
      dispatch({ type: 'challengeReceived', challengeId: challenge.id })
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
      return undefined
    },
  })

  function createSessionCredential(challenge: TempoSessionChallenge, context: SessionContext) {
    return method.createCredential({ challenge, context })
  }

  function updateSpentFromReceipt(receipt: SessionReceipt | null | undefined) {
    applySessionReceiptToRuntime({
      maxVoucherCumulative: config.maxVoucherCumulative,
      receipt,
      runtime,
    })
  }

  function activateCurrentChannel(
    units = runtime.state.status === 'active' ? runtime.state.units : 0,
  ) {
    if (!runtime.channel || !runtime.lastChallenge) return
    if (
      runtime.state.status === 'active' ||
      runtime.state.status === 'withdrawable' ||
      runtime.state.status === 'closeRequested'
    )
      return
    dispatch({
      type: 'activated',
      challengeId: runtime.lastChallenge.id,
      entry: runtime.channel,
      spent: runtime.spent.toString(),
      units,
    })
  }

  /** Persists a server snapshot into the channel store and returns the entry. */
  async function storeSnapshotHeader(response: Response): Promise<ChannelEntry | undefined> {
    const header = response.headers.get(Constants.Headers.paymentSessionSnapshot)
    if (!header) return undefined
    const entry = entryFromSnapshot(deserializeSessionSnapshot(header))
    await Promise.resolve(store.set(entry)).catch(() => undefined)
    return entry
  }

  async function bootstrapSession(
    input: RequestInfo | URL,
    init?: RequestInit | undefined,
  ): Promise<ChannelEntry | undefined> {
    if (!parameters.bootstrap) return undefined
    if (runtime.channel?.opened) return undefined

    const requestHeaders = input instanceof Request ? input.headers : undefined
    const { body: _body, method: _method, ...bootstrapInit } = init ?? {}
    const bootstrapInput = input instanceof Request ? input.url : input
    const headInit: RequestInit = {
      ...bootstrapInit,
      method: 'HEAD',
      headers: {
        ...Fetch.normalizeHeaders(requestHeaders),
        ...Fetch.normalizeHeaders(init?.headers),
        [Constants.Headers.acceptPayment]: `${Constants.Methods.tempo}/${Constants.Intents.charge}`,
      },
    }

    try {
      const challengeResponse = await config.fetch(bootstrapInput, headInit)
      if (challengeResponse.status !== 402) return await storeSnapshotHeader(challengeResponse)
      const challenge = Challenge.fromResponseList(challengeResponse).find(isTempoChargeChallenge)
      if (!challenge) return undefined
      if (!isZeroAmountChargeChallenge(challenge)) return undefined
      const credential = await chargeMethod.createCredential({
        challenge: challenge as never,
        context: {},
      })
      const response = await config.fetch(bootstrapInput, {
        ...headInit,
        headers: {
          ...Fetch.normalizeHeaders(headInit.headers),
          [Constants.Headers.authorization]: credential,
        },
      })
      if (response.ok) return await storeSnapshotHeader(response)
      return undefined
    } catch {
      return undefined
    }
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
    if (applied?.channel && runtime.lastChallenge) {
      dispatch({
        type: 'activated',
        challengeId: runtime.lastChallenge.id,
        entry: applied.channel,
        spent: runtime.spent.toString(),
        units: runtime.state.status === 'active' ? runtime.state.units : 0,
      })
    }
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
    if (restored && runtime.channel) {
      dispatch({
        type: 'activated',
        challengeId: restored.challengeId,
        entry: runtime.channel,
        spent: restored.spent,
        units: restored.units,
      })
    }
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

  async function doFetch(input: RequestInfo | URL, init?: RequestInit): Promise<PaymentResponse> {
    // The manager drives one shared `runtime` state machine, so requests are
    // single-flight. Reject overlap loudly instead of letting concurrent calls
    // corrupt each other's runtime and channel tracking.
    if (channelUse)
      throw new Error(
        'SessionManager: a request is already in flight; concurrent requests on one manager are not supported',
      )
    runtime.lastUrl = input

    const previous = captureRuntimeStateSnapshot({
      channel: runtime.channel,
      spent: runtime.spent,
      state: runtime.state,
    })
    const use: ChannelUse = {
      challengesReceived: 0,
      created: new Map(),
      previous,
      seenExisting: new Set(),
      resumed: undefined,
      trackCreates: false,
    }
    channelUse = use

    // Cold starts resume from `channelStore` after the 402 reveals the scope.
    const liveHint = runtime.channel?.opened ? runtime.channel.channelId : undefined

    try {
      await bootstrapSession(input, init)
      use.trackCreates = true

      let effectiveInit = requestInitWithSessionHint(input, init, liveHint)
      // Stored channels may be stale, so retry once after evicting the resumed entry.
      let canRetryResumed = !previous.channel?.opened

      async function retryWithoutResumed(): Promise<boolean> {
        const resumed = use.resumed
        if (!canRetryResumed || !resumed) return false
        canRetryResumed = false
        await ignoreChannel(resumed)
        effectiveInit = requestInitWithSessionHint(input, init, undefined)
        return true
      }

      for (;;) {
        let response: Response
        try {
          response = await wrappedFetch(input, effectiveInit)
        } catch (error) {
          restoreRuntime(previous)
          if (await retryWithoutResumed()) continue
          throw error
        }

        let paymentResponse = toPaymentResponse(response)
        let attemptedHttpManagement = false
        if (paymentResponse.status === 402) {
          const retry = await retryHttpPaymentRequired({
            input,
            init: effectiveInit,
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
        if (!attemptedHttpManagement && !paymentResponse.ok && !paymentResponse.receipt) {
          restoreRuntime(previous)
          if (await retryWithoutResumed()) continue
          return paymentResponse
        }
        return paymentResponse
      }
    } finally {
      channelUse = undefined
    }
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
      activateCurrentChannel()
      dispatch({ type: 'closeStarted' })
      dispatch({ type: 'closed', receipt })
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

    fetch: doFetch,

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
        doFetch,
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
      const probeUrl = webSocketProbeUrl(input)
      const signalInit = init?.signal ? { signal: init.signal } : undefined
      await bootstrapSession(probeUrl, signalInit)
      // Cold starts resume from `channelStore` after the probe's 402.
      const liveHint = runtime.channel?.opened ? runtime.channel.channelId : undefined

      const prepared = await prepareWebSocketSession({
        createSessionCredential,
        fetch: config.fetch,
        input,
        onProbeUrl(httpUrl) {
          runtime.lastUrl = httpUrl.toString()
        },
        probeInit: requestInitWithSessionHint(probeUrl, signalInit, liveHint),
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

      const activeSocket = currentSocket?.socket
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
        activateCurrentChannel()
        dispatch({ type: 'closeStarted' })
        dispatch({ type: 'closed', receipt })
        return receipt
      }

      return closeHttpSessionAndApply(target)
    },
  }

  return self
}

/** Type helpers for `sessionManager()`. */
export namespace sessionManager {
  export const serializeSnapshot = serializeSessionSnapshot
  export const deserializeSnapshot = deserializeSessionSnapshot

  export type Parameters = Account.getResolver.Parameters &
    Client.getResolver.Parameters & {
      /** Enables same-route HEAD bootstrap from a server session snapshot before opening a new channel. */
      bootstrap?: boolean | undefined
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
      /** Store for reusable session channels. Defaults to in-memory. */
      channelStore?: ChannelStore | undefined
      /** Optional websocket constructor for runtimes without a global WebSocket. */
      webSocket?: WebSocketConstructor | undefined
    }
}
