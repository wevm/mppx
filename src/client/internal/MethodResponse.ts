import type * as Challenge from '../../Challenge.js'
import type { MaybePromise } from '../../internal/types.js'
import type * as Method from '../../Method.js'

const handlers = new WeakMap<Method.AnyClient, Handler>()

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

/** Lets the selected client method handle a successful paid response. */
export function handle(method: Method.AnyClient, parameters: HandlerParameters): Promise<Response> {
  return Promise.resolve(handlers.get(method)?.(parameters) ?? parameters.response)
}
