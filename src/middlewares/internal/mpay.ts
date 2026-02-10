import type * as MethodIntent from '../../MethodIntent.js'
import type * as Mpay from '../../server/Mpay.js'

export type AnyIntentFn = Mpay.AnyIntentFn
export type AnyServer = MethodIntent.AnyServer

export type Wrap<mpay, handler> = {
  [key in keyof mpay]: mpay[key] extends (options: infer options) => any
    ? (o: options) => handler
    : mpay[key]
}

/**
 * Wraps a payment handler so each intent returns a framework-specific
 * handler instead of the raw intent response.
 *
 * @param mpay - The payment handler created by `Mpay.create`.
 * @param wrapper - A function that adapts an intent function into a framework handler.
 */
export function wrap<mpay extends Mpay.Mpay<any, any>, handler>(
  mpay: mpay,
  wrapper: (intent: AnyIntentFn, options: any) => handler,
): Wrap<mpay, handler> {
  const result: Record<string, unknown> = { ...mpay }
  for (const mi of mpay.methods as readonly MethodIntent.AnyServer[]) {
    const intentFn = (mpay as any)[mi.name]
    result[mi.name] = (options: any) => wrapper(intentFn, options)
  }
  return result as never
}
