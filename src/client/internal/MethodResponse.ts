import type * as Challenge from '../../Challenge.js'
import type * as Method from '../../Method.js'

const handler = Symbol.for('mppx.client.method.response')

export type Handler = (parameters: {
  challenge: Challenge.Challenge
  createCredential(context?: unknown): Promise<string>
  credential: string
  fetch: typeof globalThis.fetch
  input: RequestInfo | URL
  response: Response
}) => Promise<Response> | Response

type MethodWithResponseHandler = Method.AnyClient & {
  [handler]?: Handler | undefined
}

/** Returns a method's internal response hook, when one is registered. */
export function get(method: Method.AnyClient): Handler | undefined {
  return (method as MethodWithResponseHandler)[handler]
}

/** Registers an internal response hook without changing the public method type. */
export function set<const method extends Method.AnyClient>(method: method, value: Handler): method {
  Object.defineProperty(method, handler, { configurable: true, value })
  return method
}
