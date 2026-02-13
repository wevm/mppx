import type * as MethodIntent from '../../MethodIntent.js'
import type * as Mppx from '../../server/Mppx.js'

export type AnyIntentFn = Mppx.AnyIntentFn
export type AnyServer = MethodIntent.AnyServer

export type Wrap<mppx, handler> = {
  [key in keyof mppx]: mppx[key] extends (options: infer options) => any
    ? (o: options) => handler
    : mppx[key]
}

/**
 * Wraps a payment handler so each intent returns a framework-specific
 * handler instead of the raw intent response.
 *
 * @param mppx - The payment handler created by `Mppx.create`.
 * @param wrapper - A function that adapts an intent function into a framework handler.
 */
export function wrap<mppx extends Mppx.Mppx<any, any>, handler>(
  mppx: mppx,
  wrapper: (intent: AnyIntentFn, options: any) => handler,
): Wrap<mppx, handler> {
  const result: Record<string, unknown> = { ...mppx }
  for (const mi of mppx.methods as readonly MethodIntent.AnyServer[]) {
    const intentFn = (mppx as any)[mi.name]
    result[mi.name] = (options: any) => wrapper(intentFn, options)
  }
  return result as never
}
