type PaymentHandler = (request: Request) => Promise<PaymentResult>

type PaymentResult =
  | { challenge: Response; status: 402 }
  | { status: 200; withReceipt: <T>(response: T) => T }

type WithReceipt = <T>(response: T) => T

export function PaidRoute(
  handler: PaymentHandler,
  fn: (request: Request, context: { withReceipt: WithReceipt }) => Promise<Response>,
): (request: Request) => Promise<Response> {
  return async (request) => {
    const result = await handler(request)
    if (result.status === 402) return result.challenge
    return fn(request, { withReceipt: result.withReceipt })
  }
}
