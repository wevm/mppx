import type { NextFunction, Request, Response } from 'express'
import { Mpay } from 'mpay/server'

type AnyMpay = Record<string, (options: any) => (request: globalThis.Request) => Promise<any>>

export function paymentRequired(
  mpay: AnyMpay,
  intent: string,
  options: Record<string, unknown>,
): (req: Request, res: Response, next: NextFunction) => Promise<void> {
  const handler = mpay[intent]
  if (!handler) throw new Error(`Unknown intent: ${intent}`)

  return async (req, res, next) => {
    const result = await Mpay.toNodeListener(handler(options))(req, res)
    if (result.status === 402) return
    next()
  }
}
