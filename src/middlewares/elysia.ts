import type { Context } from 'elysia'
import * as Mpay_core from '../server/Mpay.js'
import * as Mpay_internal from './internal/mpay.js'

export * from '../server/Methods.js'

type ElysiaHook = (context: Context) => Promise<Response | undefined>

export namespace Mpay {
  /**
   * Creates an Elysia-aware payment handler where each intent
   * returns an Elysia `beforeHandle` hook.
   *
   * Use with `.guard()` to scope payment to specific routes,
   * or `.onBeforeHandle()` to apply globally.
   *
   * @example
   * ```ts
   * import { Elysia } from 'elysia'
   * import { Mpay, tempo } from 'mpay/elysia'
   *
   * const mpay = Mpay.create({ methods: [tempo()] })
   *
   * const app = new Elysia()
   *   .guard(
   *     { beforeHandle: mpay.charge({ amount: '1' }) },
   *     (app) => app.get('/premium', () => ({ data: 'paid content' })),
   *   )
   * ```
   */
  export function create<const methods extends Mpay_core.Methods>(
    config: Mpay_core.create.Config<methods>,
  ): Mpay_internal.Wrap<Mpay_core.Mpay<methods>, ElysiaHook> {
    return Mpay_internal.wrap(Mpay_core.create(config), payment)
  }
}

/**
 * Elysia `beforeHandle` hook that gates a route behind a payment intent.
 *
 * Returns a 402 challenge if no valid credential is provided.
 *
 * @example
 * ```ts
 * import { Elysia } from 'elysia'
 * import { Mpay } from 'mpay/server'
 * import { payment } from 'mpay/elysia'
 *
 * const mpay = Mpay.create({ methods: [tempo()] })
 *
 * const app = new Elysia()
 *   .guard(
 *     { beforeHandle: payment(mpay.charge, { amount: '1' }) },
 *     (app) => app.get('/premium', () => ({ data: 'paid content' })),
 *   )
 * ```
 */
export function payment<const intent extends Mpay_internal.AnyIntentFn>(
  intent: intent,
  options: intent extends (options: infer options) => any ? options : never,
): ElysiaHook {
  return async ({ request }) => {
    const result = await intent(options)(request)
    if (result.status === 402) return result.challenge
    if (result.response) return result.response
  }
}
