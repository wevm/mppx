import { Elysia, type AfterHandler, type OptionalHandler } from 'elysia'
import { mapResponse as mapElysiaResponse } from 'elysia/adapter/web-standard/handler'

import { generate, type GenerateConfig, type RouteConfig } from '../discovery/OpenApi.js'
import * as Scope from '../server/internal/scope.js'
import * as Mppx_core from '../server/Mppx.js'
import * as Mppx_internal from './internal/mppx.js'

export * from '../server/Methods.js'

type ElysiaHook = OptionalHandler & {
  afterHandle: AfterHandler
  beforeHandle: OptionalHandler
}

type PaymentResult = {
  withReceipt: (response?: any) => Response | Promise<Response>
}
type PendingPayment = { result: PaymentResult; supportsStreamingReceipts: boolean }

export namespace Mppx {
  /**
   * Creates an Elysia-aware payment handler where each intent
   * returns Elysia lifecycle hooks.
   *
   * Use with `.guard()` so both verification and response wrapping are scoped
   * to the same routes.
   *
   * @example
   * ```ts
   * import { Elysia } from 'elysia'
   * import { Mppx, tempo } from 'mppx/elysia'
   *
   * const mppx = Mppx.create({ methods: [tempo()] })
   *
   * const app = new Elysia()
   *   .guard(
   *     mppx.charge({ amount: '1' }),
   *     (app) => app.get('/premium', () => ({ data: 'paid content' })),
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
 *   .guard(
 *     payment(mppx.charge, { amount: '1' }),
 *     (app) => app.get('/premium', () => ({ data: 'paid content' })),
 *   )
 * ```
 */
export function payment<const intent extends Mppx_internal.AnyMethodFn>(
  intent: intent,
  options: intent extends (options: infer options) => any ? options : never,
): ElysiaHook {
  const pending = new WeakMap<Request, PendingPayment>()

  const runBeforeHandle = async (
    { request, route, set }: Parameters<OptionalHandler>[0],
    legacyRegistration: boolean,
  ) => {
    const scopedRequest =
      options.scope === undefined && Scope.read(options.meta) === undefined
        ? Scope.attach(
            request,
            `${request.method.toUpperCase()} ${route || new URL(request.url).pathname}`,
          )
        : request
    const result = await intent(options)(scopedRequest)
    if (result.status === 402) return result.challenge
    const managementResponse = await getManagementResponse(result)
    if (managementResponse) return managementResponse
    const supportsStreamingReceipts = Mppx_core.supportsStreamingReceipts(result)
    if (legacyRegistration) {
      if (supportsStreamingReceipts)
        return new Response(
          'Streaming payment hooks require paired beforeHandle and afterHandle registration.',
          { status: 500 },
        )
      const receiptResponse = await result.withReceipt(new Response(null, { status: 204 }))
      if (!receiptResponse.ok) return receiptResponse
      copyHeaders(receiptResponse, set.headers)
      return undefined
    }
    pending.set(request, { result, supportsStreamingReceipts })
    return undefined
  }
  const beforeHandle: OptionalHandler = (context) => runBeforeHandle(context, false)
  const legacyBeforeHandle: OptionalHandler = (context) => runBeforeHandle(context, true)

  const afterHandle: AfterHandler = async ({ request, responseValue, set }) => {
    const entry = pending.get(request)
    if (!entry) return
    const { result, supportsStreamingReceipts } = entry

    if (isAsyncIterableResponse(responseValue)) {
      if (supportsStreamingReceipts) {
        const response = await result.withReceipt(responseValue)
        pending.delete(request)
        return response
      }
      const receiptResponse = await result.withReceipt(new Response(null, { status: 204 }))
      pending.delete(request)
      if (!receiptResponse.ok) return receiptResponse
      copyHeaders(receiptResponse, set.headers)
      return responseValue
    }

    const response = await mapElysiaResponse(responseValue, set, request)
    const wrapped = await result.withReceipt(response)
    pending.delete(request)
    return wrapped
  }

  return Object.assign(legacyBeforeHandle, { afterHandle, beforeHandle })
}

function isAsyncIterableResponse(
  response: unknown,
): response is AsyncIterable<unknown> | ((...args: any[]) => AsyncIterable<unknown>) {
  if (typeof response === 'function') return true
  return (
    typeof response === 'object' &&
    response !== null &&
    Symbol.asyncIterator in response &&
    typeof response[Symbol.asyncIterator] === 'function'
  )
}

function copyHeaders(response: Response, headers: Record<string, unknown>) {
  for (const [key, value] of response.headers) headers[key] = value
}

async function getManagementResponse(result: {
  withReceipt: (response?: Response) => Response | Promise<Response>
}) {
  try {
    return await result.withReceipt()
  } catch (error) {
    if (Mppx_core.isMissingReceiptResponseError(error)) {
      return null
    }
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
