import type { ChannelEntry } from '../ChannelOps.js'
import type { PaymentResponse, SessionManager } from '../SessionManager.js'
import type { SseResponseOptions, TempoSessionChallenge } from '../Transports.js'

type RehydrateParameters = {
  channel: ChannelEntry
  challenge: TempoSessionChallenge
  input: RequestInfo | URL
  spent: bigint
}

type SessionManagerInternals = {
  consumeSseResponse(
    input: RequestInfo | URL,
    response: PaymentResponse,
    options?: SseResponseOptions | undefined,
  ): AsyncIterable<string>
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

/** @internal Returns private transport and recovery hooks for a session manager. */
export function getSessionManagerInternals(manager: SessionManager): SessionManagerInternals {
  const value = internals.get(manager)
  if (!value) throw new Error('Session manager internals are unavailable.')
  return value
}
