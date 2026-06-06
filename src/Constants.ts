/** HTTP header names used by the Payment authentication scheme. */
export const Headers = {
  acceptPayment: 'Accept-Payment',
  authorization: 'Authorization',
  paymentReceipt: 'Payment-Receipt',
  paymentSession: 'Payment-Session',
  paymentSessionSnapshot: 'Payment-Session-Snapshot',
  wwwAuthenticate: 'WWW-Authenticate',
} as const

/** Authentication scheme names used by mppx transports. */
export const Schemes = {
  payment: 'Payment',
} as const

/** Payment method names used by built-in mppx methods. */
export const Methods = {
  evm: 'evm',
  stripe: 'stripe',
  tempo: 'tempo',
} as const

/** Payment intent names used by built-in mppx methods. */
export const Intents = {
  charge: 'charge',
  session: 'session',
  subscription: 'subscription',
} as const

/** Method detail object keys used by built-in methods. */
export const MethodDetailKeys = {
  sessionProtocol: 'sessionProtocol',
  sessionSnapshot: 'sessionSnapshot',
} as const

/** Tempo session protocol variants advertised under `request.methodDetails`. */
export const SessionProtocols = {
  legacy: 'legacy',
  tip1034: 'tip1034',
} as const

/** Known Tempo session protocol marker values. */
export type SessionProtocol = (typeof SessionProtocols)[keyof typeof SessionProtocols]

/** Known keys that built-in methods place under `request.methodDetails`. */
export type MethodDetailKey = (typeof MethodDetailKeys)[keyof typeof MethodDetailKeys]

/**
 * Reads a typed method detail value from a challenge request.
 */
export function getMethodDetail<Value>(
  methodDetails: unknown,
  key: MethodDetailKey,
): Value | undefined {
  if (!methodDetails || typeof methodDetails !== 'object') return undefined
  return (methodDetails as Record<string, Value | undefined>)[key]
}
