import type * as Method from '../../Method.js'
import type * as Mppx from '../../server/Mppx.js'

export type AnyMethodFn = Mppx.AnyMethodFn
export type AnyServer = Method.AnyServer

export type Wrap<mppx, handler> = {
  [key in keyof mppx]: mppx[key] extends (options: infer options) => any
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
    const methodFn = (mppx as any)[mi.name]
    result[mi.name] = (options: any) => wrapper(methodFn, options)
  }
  return result as never
}
