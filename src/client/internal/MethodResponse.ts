import type * as Challenge from '../../Challenge.js'
import type { MaybePromise } from '../../internal/types.js'
import type * as Method from '../../Method.js'

const handlers = new WeakMap<Method.AnyClient, Handler>()
const attempts = new WeakMap<object, Attempt>()

export type AttemptOutcome = {
  challenges?: readonly Challenge.Challenge[] | undefined
  response?: Response | undefined
  status: 'accepted' | 'pending' | 'rejected'
}

export type Attempt = {
  /** Re-runs method preparation when serialized state changed before signing. */
  prepare: () => Promise<void>
  /** Settles state created for one credential attempt. */
  settle?: ((outcome: AttemptOutcome) => MaybePromise<boolean>) | undefined
}

/** Inputs available when a client method handles a successful paid response. */
export type HandlerParameters = {
  challenge: Challenge.Challenge
  credential: string
  fetch: typeof globalThis.fetch
  headers: Headers
  input: RequestInfo | URL
  refetch?: (() => Promise<Response>) | undefined
  response: Response
  signal?: AbortSignal | undefined
}

/** Internal client-method response adapter. */
export type Handler = (parameters: HandlerParameters) => MaybePromise<Response>

/** Registers an internal response adapter without changing the public method shape. */
export function register<const method extends Method.AnyClient>(
  method: method,
  handler: Handler,
): method {
  handlers.set(method, handler)
  return method
}

/** Removes response handling from a method whose caller owns the response lifecycle. */
export function unregister(method: Method.AnyClient): void {
  handlers.delete(method)
}

/** Adds response lifecycle state to internal credential parameters. */
export function attachAttempt(
  method: Method.AnyClient,
  parameters: object,
  attempt: Attempt,
): void {
  if (handlers.has(method)) attempts.set(parameters, attempt)
}

/** Reads response lifecycle state when Fetch owns this credential. */
export function getAttempt(parameters: object): Attempt | undefined {
  return attempts.get(parameters)
}

/** Lets the selected client method handle a successful paid response. */
export function handle(method: Method.AnyClient, parameters: HandlerParameters): Promise<Response> {
  return Promise.resolve(handlers.get(method)?.(parameters) ?? parameters.response)
}
