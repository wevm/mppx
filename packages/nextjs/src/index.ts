type AnyMpay = Record<string, (options: any) => (request: Request) => Promise<any>>

type WithReceipt = <T>(response: T) => T

type RouteContext = {
  withReceipt: WithReceipt
}

type RouteHandler = (request: Request, context: RouteContext) => Promise<Response>

export function PaidRoute(
  mpay: AnyMpay,
  intent: string,
  options: Record<string, unknown>,
  handler: RouteHandler,
): (request: Request) => Promise<Response> {
  const intentFn = mpay[intent]
  if (!intentFn) throw new Error(`Unknown intent: ${intent}`)

  return async (request: Request) => {
    const result = await intentFn(options)(request)
    if (result.status === 402) return result.challenge as Response
    return handler(request, { withReceipt: result.withReceipt as WithReceipt })
  }
}
