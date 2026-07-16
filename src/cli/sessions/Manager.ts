import * as Challenge from '../../Challenge.js'
import type { ChannelEntry } from '../../tempo/session/client/ChannelOps.js'
import { resolveEscrow } from '../../tempo/session/client/ChannelOps.js'
import {
  consumeSessionManagerSseResponse,
  getSessionManagerCloseAttempt,
  rehydrateSessionManager,
} from '../../tempo/session/client/internal/SessionManager.js'
import { isExpectedCloseReceipt } from '../../tempo/session/client/Runtime.js'
import {
  sessionManager,
  type PaymentResponse,
  type SessionManager,
  type SessionManagerSseOptions,
} from '../../tempo/session/client/SessionManager.js'
import type { TempoSessionChallenge } from '../../tempo/session/client/Transports.js'
import {
  getSessionSnapshot,
  isTempoSessionChallenge,
} from '../../tempo/session/client/Transports.js'
import { isEventStream, type SessionReceipt } from '../../tempo/session/precompile/Protocol.js'

type ManagerParameters = Omit<sessionManager.Parameters, 'bootstrap' | 'fetch'>

/** Inputs for a CLI request that already selected a tempo/session challenge response. */
export type RequestWithSessionManagerParameters = {
  /** Selected initial HTTP 402 response. */
  challengeResponse: Response
  /** Network fetch used after the replayed challenge. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch | undefined
  /** Original request options, plus an optional SSE receipt callback. */
  init?: SessionManagerSseOptions | undefined
  /** Original paid resource URL or request. */
  input: RequestInfo | URL
  /** Session manager account, client, policy, and channel-store parameters. */
  manager: ManagerParameters
  /** Durable channel context to restore before replaying the challenge. */
  resume?: {
    channel: ChannelEntry
    challenge: TempoSessionChallenge
    spent: bigint
  }
}

type SharedRequestResult = {
  manager: SessionManager
  response: PaymentResponse
}

/** Result of one managed CLI resource request. */
export type SessionManagerRequestResult =
  | (SharedRequestResult & { kind: 'response' })
  | (SharedRequestResult & { kind: 'event-stream'; stream: AsyncIterable<string> })

/** Inputs for closing a durable session through a newly created manager. */
export type CloseWithSessionManagerParameters = {
  /** Durable open channel entry. */
  channel: ChannelEntry
  /** Latest validated challenge for the channel scope. */
  challenge: TempoSessionChallenge
  /** Network fetch used for the cooperative close request. Defaults to global fetch. */
  fetch?: typeof globalThis.fetch | undefined
  /** Exact resource URL used as the cooperative close endpoint. */
  input: RequestInfo | URL
  /** Session manager account, client, policy, and channel-store parameters. */
  manager: ManagerParameters
  /** Persists a validated refreshed close challenge before retrying. */
  onChallenge?: ((challenge: TempoSessionChallenge) => void | Promise<void>) | undefined
  /** Latest receipt-confirmed spend in raw token units. */
  spent: bigint
}

/** Result of a rehydrated cooperative close. */
export type CloseWithSessionManagerResult = {
  manager: SessionManager
  receipt: SessionReceipt
}

function resolveFetch(fetch: typeof globalThis.fetch | undefined): typeof globalThis.fetch {
  return fetch ?? globalThis.fetch.bind(globalThis)
}

function assertCloseChallengeScope(challenge: TempoSessionChallenge, channel: ChannelEntry): void {
  const chainId = (challenge.request.methodDetails as { chainId?: unknown } | undefined)?.chainId
  if (chainId !== undefined && chainId !== channel.chainId)
    throw new Error('Close challenge changed the session chain.')
  if (
    typeof challenge.request.recipient !== 'string' ||
    challenge.request.recipient.toLowerCase() !== channel.descriptor.payee.toLowerCase()
  )
    throw new Error('Close challenge changed the session payee.')
  if (
    typeof challenge.request.currency !== 'string' ||
    challenge.request.currency.toLowerCase() !== channel.descriptor.token.toLowerCase()
  )
    throw new Error('Close challenge changed the session token.')
  if (resolveEscrow(challenge).toLowerCase() !== channel.escrow.toLowerCase())
    throw new Error('Close challenge changed the session escrow.')
  const snapshot = getSessionSnapshot(challenge)
  if (snapshot && snapshot.channelId.toLowerCase() !== channel.channelId.toLowerCase())
    throw new Error('Close challenge changed the session channel.')
}

/**
 * Replays a selected 402 through the session manager, performs one paid resource
 * request, and consumes that same response when it is an event stream.
 */
export async function requestWithSessionManager(
  parameters: RequestWithSessionManagerParameters,
): Promise<SessionManagerRequestResult> {
  if (parameters.challengeResponse.status !== 402) {
    throw new Error('Session manager replay requires a 402 challenge response.')
  }
  if (parameters.challengeResponse.bodyUsed) {
    throw new Error('Session manager replay requires an unconsumed challenge response.')
  }

  const networkFetch = resolveFetch(parameters.fetch)
  let replayPending = true
  const replayFetch: typeof globalThis.fetch = async (input, init) => {
    if (replayPending) {
      replayPending = false
      return parameters.challengeResponse
    }
    return networkFetch(input, init)
  }
  const manager = sessionManager({
    ...parameters.manager,
    bootstrap: false,
    fetch: replayFetch,
  })
  if (parameters.resume)
    rehydrateSessionManager(manager, {
      ...parameters.resume,
      input: parameters.input,
    })
  const { onReceipt, ...requestInit } = parameters.init ?? {}
  const response = await manager.fetch(parameters.input, requestInit)

  if (!isEventStream(response)) return { kind: 'response', manager, response }
  return {
    kind: 'event-stream',
    manager,
    response,
    stream: consumeSessionManagerSseResponse(manager, parameters.input, response, {
      onReceipt,
      signal: parameters.init?.signal,
    }),
  }
}

/** Rehydrates durable session context and cooperatively closes it through the manager. */
export async function closeWithSessionManager(
  parameters: CloseWithSessionManagerParameters,
): Promise<CloseWithSessionManagerResult> {
  assertCloseChallengeScope(parameters.challenge, parameters.channel)
  const networkFetch = resolveFetch(parameters.fetch)
  const validatedFetch: typeof globalThis.fetch = async (input, init) => {
    const response = await networkFetch(input, init)
    if (response.status !== 402) return response
    const refreshed = Challenge.fromResponseList(response).find(isTempoSessionChallenge)
    if (!refreshed) throw new Error('Refreshed close response did not include tempo/session.')
    assertCloseChallengeScope(refreshed, parameters.channel)
    await parameters.onChallenge?.(refreshed)
    return response
  }
  const manager = sessionManager({
    ...parameters.manager,
    bootstrap: false,
    fetch: validatedFetch,
  })
  rehydrateSessionManager(manager, parameters)
  const receipt = await manager.close()
  if (!receipt) throw new Error('Session close response did not include a payment receipt.')

  const closeAttempt = getSessionManagerCloseAttempt(manager)
  if (
    !closeAttempt ||
    !isExpectedCloseReceipt({
      challengeId: closeAttempt.challengeId,
      channelId: parameters.channel.channelId,
      expectedCloseAmount: closeAttempt.signedCloseAmount,
      receipt,
    })
  ) {
    throw new Error('Session close response included a mismatched payment receipt.')
  }

  return { manager, receipt }
}
