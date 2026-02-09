import type { MiddlewareHandler } from 'hono'

type PaymentHandler = (request: Request) => Promise<PaymentResult>

type PaymentResult =
  | { challenge: Response; status: 402 }
  | { status: 200; withReceipt: <T>(response: T) => T }

type WithReceipt = <T>(response: T) => T

type PaymentEnv = {
  Variables: {
    withReceipt: WithReceipt
  }
}

export function paymentRequired(handler: PaymentHandler): MiddlewareHandler<PaymentEnv> {
  return async (c, next) => {
    const result = await handler(c.req.raw)
    if (result.status === 402) return result.challenge as Response
    c.set('withReceipt', result.withReceipt)
    await next()
  }
}
