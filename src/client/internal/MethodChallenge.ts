import type * as Challenge from '../../Challenge.js'
import type { MaybePromise } from '../../internal/types.js'
import type * as Method from '../../Method.js'

const handlers = new WeakMap<Method.AnyClient, Handler>()

/** Inputs available before a client method creates a challenge credential. */
export type HandlerParameters = {
  challenge: Challenge.Challenge
  context?: unknown
  fetch: typeof globalThis.fetch
  input: RequestInfo | URL
}

/** Internal client-method challenge hook. */
export type Handler = (parameters: HandlerParameters) => MaybePromise<void>

/** Registers an internal challenge hook without changing the public method shape. */
export function register<const method extends Method.AnyClient>(
  method: method,
  handler: Handler,
): method {
  handlers.set(method, handler)
  return method
}

/** Returns whether a method registered pre-credential work. */
export function has(method: Method.AnyClient): boolean {
  return handlers.has(method)
}

/** Runs method-specific work before creating a challenge credential. */
export function handle(method: Method.AnyClient, parameters: HandlerParameters): Promise<void> {
  return Promise.resolve(handlers.get(method)?.(parameters))
}
