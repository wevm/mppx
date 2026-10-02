import { Elysia, type Context } from 'elysia'

import { generate, type GenerateConfig, type RouteConfig } from '../discovery/OpenApi.js'
import * as Scope from '../server/internal/scope.js'
import * as Mppx_core from '../server/Mppx.js'
import * as Mppx_internal from './internal/mppx.js'

export * from '../server/Methods.js'

type ElysiaBeforeHandle = (context: {
  request: Request
  route?: string | undefined
  set: Context['set']
}) => Promise<Response | undefined>

type ElysiaHook = ElysiaBeforeHandle & {
  afterResponse(context: { request: Request; set: Context['set'] }): Promise<void>
  afterHandle(context: { request: Request; set: Context['set'] }): Promise<Response | undefined>
  beforeHandle(context: {
    request: Request
    route?: string | undefined
    set: Context['set']
  }): Promise<Response | undefined>
  error(context: { request: Request; set: Context['set'] }): Promise<void>
}

type PendingResult = {
  cancelReceipt?: () => Promise<void> | void
  withReceipt(response?: Response): Promise<Response> | Response
}

export namespace Mppx {
  /**
   * Creates an Elysia-aware payment handler where each intent returns
   * Elysia lifecycle hooks.
   *
   * Use with `.guard()` to scope payment to specific routes.
   *
   * @example
   * ```ts
   * import { Elysia } from 'elysia'
   * import { Mppx, tempo } from 'mppx/elysia'
   *
   * const mppx = Mppx.create({ methods: [tempo()] })
   *
   * const app = new Elysia()
   *   .guard(mppx.charge({ amount: '1' }), (app) =>
   *     app.get('/premium', () => ({ data: 'paid content' })),
   *   )
   * ```
   */
  export function create<const methods extends Mppx_core.Methods>(
    config: Mppx_core.create.Config<methods>,
  ): Mppx_internal.Wrap<Mppx_core.Mppx<methods>, ElysiaHook> {
    return Mppx_internal.wrap(Mppx_core.create(config), payment)
  }
}

/**
 * Elysia lifecycle hooks that gate a route behind a payment intent.
 *
 * Returns a 402 challenge if no valid credential is provided.
 *
 * @example
 * ```ts
 * import { Elysia } from 'elysia'
 * import { Mppx } from 'mppx/server'
 * import { payment } from 'mppx/elysia'
 *
 * const mppx = Mppx.create({ methods: [tempo()] })
 *
 * const app = new Elysia()
 *   .guard(payment(mppx.charge, { amount: '1' }), (app) =>
 *     app.get('/premium', () => ({ data: 'paid content' })),
 *   )
 * ```
 */
export function payment<const intent extends Mppx_internal.AnyMethodFn>(
  intent: intent,
  options: intent extends (options: infer options) => any ? options : never,
): ElysiaHook {
  const pending = new WeakMap<object, PendingResult>()
  const finalized = new WeakSet<object>()
  const beforeHandle: ElysiaHook['beforeHandle'] = async ({ request, route, set }) => {
    const scopedRequest =
      options.scope === undefined && Scope.read(options.meta) === undefined
        ? Scope.attach(
            request,
            `${request.method.toUpperCase()} ${route || new URL(request.url).pathname}`,
          )
        : request
    const result = await intent(options)(scopedRequest)
    if (result.status === 402) return result.challenge
    await cancelIfAborted(request.signal, result)
    const managementResponse = await getManagementResponse(result)
    await cancelIfAborted(request.signal, result)
    if (managementResponse) return managementResponse
    pending.set(set, result)
  }
  const afterHandle: ElysiaHook['afterHandle'] = async ({ set }) => {
    const result = pending.get(set)
    if (!result) return
    try {
      const receipt = await result.withReceipt(new Response())
      if (!receipt.ok) return receipt
      for (const [key, value] of receipt.headers) set.headers[key] = value
      finalized.add(set)
    } catch (error) {
      if (await cancelReceipt(result)) pending.delete(set)
      throw error
    }
  }
  const cancelPending = async (set: Context['set']) => {
    const result = pending.get(set)
    if (!result) return
    if (await cancelReceipt(result)) {
      finalized.delete(set)
      pending.delete(set)
    }
  }
  const error: ElysiaHook['error'] = async ({ set }) => cancelPending(set)
  const afterResponse: ElysiaHook['afterResponse'] = async ({ set }) => {
    if (!finalized.has(set)) return cancelPending(set)
    finalized.delete(set)
    pending.delete(set)
  }

  const legacyBeforeHandle: ElysiaBeforeHandle = async (context) => {
    const response = await beforeHandle(context)
    if (response) return response
    await cancelPending(context.set)
    return new Response(
      'Deferred payment receipts require full Elysia lifecycle hooks. Pass payment(...) directly to .guard().',
      { status: 500 },
    )
  }

  return Object.assign(legacyBeforeHandle, { afterHandle, afterResponse, beforeHandle, error })
}

async function cancelIfAborted(signal: AbortSignal, result: PendingResult) {
  if (!signal.aborted) return
  await cancelReceipt(result)
  throw signal.reason ?? new DOMException('The operation was aborted.', 'AbortError')
}

async function cancelReceipt(result: { cancelReceipt?: (() => Promise<void> | void) | undefined }) {
  try {
    await result.cancelReceipt?.()
    return true
  } catch {
    return false
  }
}

async function getManagementResponse(result: {
  cancelReceipt?: (() => Promise<void> | void) | undefined
  withReceipt: (response?: Response) => Promise<Response> | Response
}) {
  try {
    return await result.withReceipt()
  } catch (error) {
    if (Mppx_core.isMissingReceiptResponseError(error)) {
      return null
    }
    await cancelReceipt(result)
    throw error
  }
}

export type DiscoveryConfig = Omit<GenerateConfig, 'routes'> & {
  path?: string
  routes?: RouteConfig[]
}

const discoveryHeaders = { 'Cache-Control': 'public, max-age=300' }

/**
 * Returns an Elysia plugin that serves an OpenAPI discovery document.
 */
export function discovery(
  mppx: { methods: readonly Mppx_internal.AnyServer[]; realm: string },
  config: DiscoveryConfig = {},
) {
  const mountPath = config.path ?? '/openapi.json'

  const cached = JSON.stringify(
    generate(mppx, {
      ...(config.info ? { info: config.info } : {}),
      routes: config.routes ?? [],
      ...(config.serviceInfo ? { serviceInfo: config.serviceInfo } : {}),
    }),
  )

  return new Elysia().get(
    mountPath,
    () =>
      new Response(cached, {
        headers: { ...discoveryHeaders, 'Content-Type': 'application/json' },
      }),
  )
}
