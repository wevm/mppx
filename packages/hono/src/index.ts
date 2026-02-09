import type { MiddlewareHandler } from 'hono'

type AnyMpay = Record<string, (options: any) => (request: Request) => Promise<any>>

type WithReceipt = <T>(response: T) => T

type PaymentEnv = {
  Variables: {
    withReceipt: WithReceipt
  }
}

export function paymentRequired<M extends AnyMpay>(
  mpay: M,
  intent: keyof M & string,
  options: Record<string, unknown>,
): MiddlewareHandler<PaymentEnv> {
  const handler = mpay[intent]
  if (!handler) throw new Error(`Unknown intent: ${intent}`)

  return async (c, next) => {
    const result = await handler(options)(c.req.raw)

    if (result.status === 402) return result.challenge as Response

    c.set('withReceipt', result.withReceipt as WithReceipt)
    await next()
  }
}
