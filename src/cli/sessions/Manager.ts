import * as Challenge from '../../Challenge.js'
import type { ChannelEntry } from '../../tempo/session/client/ChannelOps.js'
import { resolveEscrow } from '../../tempo/session/client/ChannelOps.js'
import { getSessionManagerInternals } from '../../tempo/session/client/internal/SessionManager.js'
import { sessionManager, type SessionManager } from '../../tempo/session/client/SessionManager.js'
import type { TempoSessionChallenge } from '../../tempo/session/client/Transports.js'
import {
  getSessionSnapshot,
  isTempoSessionChallenge,
} from '../../tempo/session/client/Transports.js'
import type { SessionReceipt } from '../../tempo/session/precompile/Protocol.js'

type ManagerParameters = Omit<sessionManager.Parameters, 'bootstrap' | 'fetch'>

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

/** Rehydrates durable session context and cooperatively closes it through the manager. */
export async function closeWithSessionManager(
  parameters: CloseWithSessionManagerParameters,
): Promise<CloseWithSessionManagerResult> {
  assertCloseChallengeScope(parameters.challenge, parameters.channel)
  const networkFetch = resolveFetch(parameters.fetch)
  let pendingChallenge: TempoSessionChallenge | undefined
  const validatedFetch: typeof globalThis.fetch = async (input, init) => {
    if (pendingChallenge) {
      await parameters.onChallenge?.(pendingChallenge)
      pendingChallenge = undefined
    }
    const response = await networkFetch(input, init)
    if (response.status !== 402) return response
    const refreshed = Challenge.fromResponseList(response).find(isTempoSessionChallenge)
    if (!refreshed) throw new Error('Refreshed close response did not include tempo/session.')
    assertCloseChallengeScope(refreshed, parameters.channel)
    pendingChallenge = refreshed
    return response
  }
  const manager = sessionManager({
    ...parameters.manager,
    bootstrap: false,
    fetch: validatedFetch,
  })
  getSessionManagerInternals(manager).rehydrate(parameters)
  const receipt = await manager.close()
  if (!receipt) throw new Error('Session close response did not include a payment receipt.')
  return { manager, receipt }
}
