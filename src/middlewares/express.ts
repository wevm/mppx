import type {
  Express,
  Request as ExpressRequest,
  Response as ExpressResponse,
  NextFunction,
  RequestHandler,
} from 'express'

import { generate, type GenerateConfig, type RouteConfig } from '../discovery/OpenApi.js'
import * as Scope from '../server/internal/scope.js'
import * as Mppx_core from '../server/Mppx.js'
import * as ExpressAdapter from './internal/express.js'
import * as Mppx_internal from './internal/mppx.js'

export * from '../server/Methods.js'

export namespace Mppx {
  /**
   * Creates an Express-aware payment handler where each intent
   * returns an Express `RequestHandler`.
   *
   * @example
   * ```ts
   * import express from 'express'
   * import { Mppx, tempo } from 'mppx/express'
   *
   * const app = express()
   * const mppx = Mppx.create({ methods: [tempo()] })
   *
   * app.get('/premium', mppx.charge({ amount: '1' }), (req, res) => {
   *   res.json({ data: 'paid content' })
   * })
   * ```
   */
  export function create<const methods extends Mppx_core.Methods>(
    config: Mppx_core.create.Config<methods>,
  ): Mppx_internal.Wrap<Mppx_core.Mppx<methods>, RequestHandler> {
    return Mppx_internal.wrap(Mppx_core.create(config), payment)
  }
}

/**
 * Express middleware that gates a route behind a payment intent.
 *
 * Returns a 402 challenge if no valid credential is provided,
 * otherwise attaches a `Payment-Receipt` header to the response.
 *
 * @example
 * ```ts
 * import express from 'express'
 * import { Mppx } from 'mppx/server'
 * import { payment } from 'mppx/express'
 *
 * const mppx = Mppx.create({ methods: [tempo()] })
 *
 * const app = express()
 * app.get('/premium', payment(mppx.charge, { amount: '1' }), (req, res) => {
 *   res.json({ data: 'paid content' })
 * })
 * ```
 */
export function payment<const intent extends Mppx_internal.AnyMethodFn>(
  intent: intent,
  options: intent extends (options: infer options) => any ? options : never,
): RequestHandler {
  return async (req: ExpressRequest, res: ExpressResponse, next: NextFunction) => {
    let responseClosed = res.destroyed
    let releaseReceipt: (() => void) | undefined
    res.once('close', () => {
      responseClosed = true
      releaseReceipt?.()
    })

    const rawRequest = ExpressAdapter.toRequest(req)
    const routePath = typeof req.route?.path === 'string' ? req.route.path : req.path
    const request =
      options.scope === undefined && Scope.read(options.meta) === undefined
        ? Scope.attach(rawRequest, `${req.method.toUpperCase()} ${req.baseUrl}${routePath}`)
        : rawRequest
    const result = await intent(options)(request)

    if (result.status === 402) {
      if (responseClosed) return
      const challenge = result.challenge as Response
      await ExpressAdapter.sendResponse(res, challenge)
      return
    }

    let receiptFinalizing = false
    let receiptHandled = false
    let receiptReleased = false
    let receiptReleasePending = false
    let receiptReleaseRetry = false
    releaseReceipt = () => {
      if (receiptHandled || receiptReleased) return
      if (receiptReleasePending) {
        receiptReleaseRetry = true
        return
      }
      receiptReleasePending = true
      void Promise.resolve()
        .then(() => result.cancelReceipt?.())
        .then(
          () => {
            receiptReleasePending = false
            receiptReleased = true
          },
          (error) => {
            receiptReleasePending = false
            next(error)
            if (receiptReleaseRetry) {
              receiptReleaseRetry = false
              releaseReceipt?.()
            }
          },
        )
    }
    if (responseClosed) {
      releaseReceipt()
      return
    }

    const managementResponse = await (async () => {
      try {
        return await (result.withReceipt as () => Promise<Response> | Response)()
      } catch (error) {
        if (Mppx_core.isMissingReceiptResponseError(error)) return null
        try {
          await result.cancelReceipt?.()
          receiptReleased = true
        } catch {
          // Preserve the management response error when cleanup also fails.
        }
        throw error
      }
    })()
    if (responseClosed || receiptReleased) return

    if (managementResponse) {
      receiptHandled = true
      res.status(managementResponse.status)
      ExpressAdapter.copyHeaders(res, managementResponse.headers)
      if (managementResponse.body === null) {
        res.end()
        return
      }
      res.send(Buffer.from(await managementResponse.arrayBuffer()))
      return
    }

    const originalJson = res.json.bind(res)
    res.once('finish', releaseReceipt)
    res.json = (body: any) => {
      if (receiptFinalizing || receiptHandled || responseClosed) return res
      receiptFinalizing = true
      void Promise.resolve()
        .then(() => result.withReceipt(Response.json(body)))
        .then(async (wrapped) => {
          receiptFinalizing = false
          if (responseClosed || receiptReleased) return
          receiptHandled = true
          if (!wrapped.ok) {
            await ExpressAdapter.sendResponse(res, wrapped)
            return
          }
          ExpressAdapter.copyHeaders(res, wrapped.headers)
          originalJson(body)
        })
        .catch(async (error) => {
          receiptFinalizing = false
          receiptHandled = false
          try {
            await result.cancelReceipt?.()
          } catch {
            // Preserve the original response error when cleanup also fails.
          } finally {
            next(error)
          }
        })
      return res
    }

    next()
  }
}

export type DiscoveryConfig = Omit<GenerateConfig, 'routes'> & {
  path?: string
  routes?: RouteConfig[]
}

const discoveryHeaders = { 'Cache-Control': 'public, max-age=300' }

/**
 * Mounts a `GET /openapi.json` route that serves an OpenAPI discovery document.
 */
export function discovery(
  app: Express,
  mppx: { methods: readonly Mppx_internal.AnyServer[]; realm: string },
  config: DiscoveryConfig = {},
): void {
  const mountPath = config.path ?? '/openapi.json'

  const cached = JSON.stringify(
    generate(mppx, {
      ...(config.info ? { info: config.info } : {}),
      routes: config.routes ?? [],
      ...(config.serviceInfo ? { serviceInfo: config.serviceInfo } : {}),
    }),
  )

  app.get(mountPath, (_req: ExpressRequest, res: ExpressResponse) => {
    res.setHeader('Cache-Control', discoveryHeaders['Cache-Control'])
    res.setHeader('Content-Type', 'application/json')
    res.end(cached)
  })
}
