import type { NextFunction, Request, Response } from 'express'
import { Mpay } from 'mpay/server'

type PaymentHandler = (request: globalThis.Request) => Promise<PaymentResult>

type PaymentResult =
  | { challenge: globalThis.Response; status: 402 }
  | { status: 200; withReceipt: <T>(response: T) => T }

export function paymentRequired(
  handler: PaymentHandler,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  return async (req, res, next) => {
    const result = await Mpay.toNodeListener(handler)(req, res)
    if (result.status === 402) return
    next()
  }
}
