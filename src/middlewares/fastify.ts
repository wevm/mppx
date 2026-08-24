import type { FastifyInstance, preHandlerHookHandler } from 'fastify'

import { generate, type GenerateConfig, type RouteConfig } from '../discovery/OpenApi.js'
import * as Mppx_core from '../server/Mppx.js'
import * as FastifyAdapter from './internal/fastify.js'
import * as Mppx_internal from './internal/mppx.js'

export * from '../server/Methods.js'

export namespace Mppx {
  /** Creates Fastify pre-handler hooks for every configured payment intent. */
  export function create<const methods extends Mppx_core.Methods>(
    config: Mppx_core.create.Config<methods>,
  ): Mppx_internal.Wrap<Mppx_core.Mppx<methods>, preHandlerHookHandler> {
    return Mppx_internal.wrap(Mppx_core.create(config), payment)
  }
}

/**
 * Creates a Fastify pre-handler hook that gates a route behind a payment intent.
 *
 * Successful receipt headers are installed before the application handler runs,
 * so Fastify can retain its normal serialization and streaming behavior.
 */
export function payment<const intent extends Mppx_internal.AnyMethodFn>(
  intent: intent,
  options: intent extends (options: infer options) => any ? options : never,
): preHandlerHookHandler {
  return async (request, reply) => {
    const result = await intent(options)(FastifyAdapter.toRequest(request))
    if (result.status === 402) return FastifyAdapter.sendResponse(reply, result.challenge)

    const managementResponse = getManagementResponse(result)
    if (managementResponse) return FastifyAdapter.sendResponse(reply, managementResponse)

    const response = result.withReceipt(new Response(null))
    FastifyAdapter.copyHeaders(reply, response.headers)
  }
}

/** Configuration for the Fastify OpenAPI discovery route. */
export type DiscoveryConfig = Omit<GenerateConfig, 'routes'> & {
  path?: string
  routes?: RouteConfig[]
}

/** Registers an OpenAPI payment-discovery endpoint on a Fastify instance. */
export function discovery(
  app: FastifyInstance,
  mppx: { methods: readonly Mppx_internal.AnyServer[]; realm: string },
  config: DiscoveryConfig = {},
): void {
  const document = generate(mppx, {
    ...(config.info ? { info: config.info } : {}),
    routes: config.routes ?? [],
    ...(config.serviceInfo ? { serviceInfo: config.serviceInfo } : {}),
  })
  app.get(config.path ?? '/openapi.json', (_request, reply) => {
    reply.header('Cache-Control', 'public, max-age=300').send(document)
  })
}

function getManagementResponse(result: { withReceipt: (response?: Response) => Response }) {
  try {
    return result.withReceipt()
  } catch (error) {
    if (Mppx_core.isMissingReceiptResponseError(error)) return null
    throw error
  }
}
