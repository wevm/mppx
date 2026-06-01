import * as Types from '../Types.js'

/** Resolves an x402 facilitator URL or client into a facilitator client. */
export function resolve(
  facilitator: string | Types.Facilitator,
  errorMessage = 'x402 exact requires `facilitator`.',
): Types.Facilitator {
  if (typeof facilitator === 'object' && facilitator !== null) return facilitator
  if (typeof facilitator === 'string') return http(facilitator)
  throw new Error(errorMessage)
}

/** Creates an x402 facilitator client from an HTTP base URL. */
export function http(url: string): Types.Facilitator {
  const base = url.replace(/\/$/, '')
  return {
    async verify(paymentPayload, paymentRequirements) {
      const response = await fetch(`${base}/verify`, {
        body: JSON.stringify({ paymentPayload, paymentRequirements }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      return Types.VerifyResponseSchema.parse(await response.json())
    },
    async settle(paymentPayload, paymentRequirements) {
      const response = await fetch(`${base}/settle`, {
        body: JSON.stringify({ paymentPayload, paymentRequirements }),
        headers: { 'Content-Type': 'application/json' },
        method: 'POST',
      })
      return Types.SettleResponseSchema.parse(await response.json())
    },
  }
}
