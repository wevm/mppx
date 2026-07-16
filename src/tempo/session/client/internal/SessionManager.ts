import type { ChannelEntry } from '../ChannelOps.js'
import type { PaymentResponse, SessionManager } from '../SessionManager.js'
import type { SseResponseOptions, TempoSessionChallenge } from '../Transports.js'

type RehydrateParameters = {
  channel: ChannelEntry
  challenge: TempoSessionChallenge
  input: RequestInfo | URL
  spent: bigint
}

type CloseAttempt = {
  challengeId: string
  signedCloseAmount: string
}

type SessionManagerInternals = {
  consumeSseResponse(
    input: RequestInfo | URL,
    response: PaymentResponse,
    options?: SseResponseOptions | undefined,
  ): AsyncIterable<string>
  getCloseAttempt(): CloseAttempt | null
  rehydrate(parameters: RehydrateParameters): void
}

const internals = new WeakMap<SessionManager, SessionManagerInternals>()

/** @internal Registers private transport and recovery hooks for a session manager. */
export function registerSessionManagerInternals(
  manager: SessionManager,
  value: SessionManagerInternals,
): void {
  internals.set(manager, value)
}

function getSessionManagerInternals(manager: SessionManager): SessionManagerInternals {
  const value = internals.get(manager)
  if (!value) throw new Error('Session manager internals are unavailable.')
  return value
}

/** @internal Consumes an already-paid SSE response without issuing another resource request. */
export function consumeSessionManagerSseResponse(
  manager: SessionManager,
  input: RequestInfo | URL,
  response: PaymentResponse,
  options?: SseResponseOptions | undefined,
): AsyncIterable<string> {
  return getSessionManagerInternals(manager).consumeSseResponse(input, response, options)
}

/** @internal Returns the latest close credential boundary signed by a session manager. */
export function getSessionManagerCloseAttempt(manager: SessionManager): CloseAttempt | null {
  return getSessionManagerInternals(manager).getCloseAttempt()
}

/** @internal Restores durable channel context before an explicit CLI close. */
export function rehydrateSessionManager(
  manager: SessionManager,
  parameters: RehydrateParameters,
): void {
  getSessionManagerInternals(manager).rehydrate(parameters)
}
