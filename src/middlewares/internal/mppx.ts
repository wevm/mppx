import type * as Method from '../../Method.js'
import type * as Mppx from '../../server/Mppx.js'

export type AnyMethodFn = Mppx.AnyMethodFn
export type AnyServer = Method.AnyServer

export type Wrap<mppx, handler> = {
  // `challenge` is passed through unwrapped because it's a multi-method
  // combinator (takes `[method, options]` tuples), not a per-method handler.
  // `methods`, `realm`, `transport` are data properties — not handlers.
  [key in keyof mppx]: key extends 'challenge' | 'methods' | 'realm' | 'transport'
    ? mppx[key]
    : mppx[key] extends (options: infer options) => any
      ? (o: options) => handler
      : mppx[key]
}

/**
 * Wraps a payment handler so each method returns a framework-specific
 * handler instead of the raw method response.
 *
 * @param mppx - The payment handler created by `Mppx.create`.
 * @param wrapper - A function that adapts a method function into a framework handler.
 */
export function wrap<mppx extends Mppx.Mppx<any, any>, handler>(
  mppx: mppx,
  wrapper: (method: AnyMethodFn, options: any) => handler,
): Wrap<mppx, handler> {
  const result: Record<string, unknown> = { ...mppx }
  for (const mi of mppx.methods as readonly Method.AnyServer[]) {
    const key = `${mi.name}/${mi.intent}`
    const methodFn = (mppx as any)[key]
    result[key] = (options: any) => wrapper(methodFn, options)
    // Also set shorthand intent key if Mppx registered it (no collision)
    if ((mppx as any)[mi.intent]) result[mi.intent] = (options: any) => wrapper(methodFn, options)
  }
  return result as never
}
