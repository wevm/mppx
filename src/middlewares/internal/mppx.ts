import type * as Method from '../../Method.js'
import type * as Mppx from '../../server/Mppx.js'

export type AnyMethodFn = Mppx.AnyMethodFn
export type AnyServer = Method.AnyServer

/** Recursively wraps nested handler objects one level deep. */
type WrapNested<obj, handler> = {
  [key in keyof obj]: obj[key] extends (options: infer options) => any
    ? (o: options) => handler
    : obj[key]
}

export type Wrap<mppx, handler> = {
  // `compose` is omitted — it returns a raw HTTP handler, not a
  // middleware-shaped result. Use `Mppx.compose()` static instead.
  // `methods`, `realm`, `transport` are data properties — not handlers.
  [key in keyof mppx as key extends 'compose' ? never : key]: key extends
    | 'html'
    | 'methods'
    | 'realm'
    | 'transport'
    ? mppx[key]
    : mppx[key] extends (options: infer options) => any
      ? (o: options) => handler
      : mppx[key] extends Record<string, (options: any) => any>
        ? WrapNested<mppx[key], handler>
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
  const { compose: _, ...rest } = mppx as any
  const result: Record<string, unknown> = { ...rest }
  for (const mi of mppx.methods as readonly Method.AnyServer[]) {
    const key = `${mi.name}/${mi.intent}`
    const methodFn = (mppx as any)[key]
    result[key] = (options: any) => wrapper(methodFn, options)
    // Also set shorthand intent key if Mppx registered it (no collision)
    if ((mppx as any)[mi.intent]) result[mi.intent] = (options: any) => wrapper(methodFn, options)
    // Build nested handlers: wrapped.tempo.charge(...)
    if (!result[mi.name] || typeof result[mi.name] !== 'object')
      result[mi.name] = {} as Record<string, unknown>
    ;(result[mi.name] as Record<string, unknown>)[mi.intent] = (options: any) =>
      wrapper(methodFn, options)
  }
  return result as never
}
