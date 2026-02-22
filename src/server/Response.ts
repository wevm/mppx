import * as Challenge from '../Challenge.js'
import type * as Errors from '../Errors.js'

/**
 * Creates a 402 Payment Required response with a `WWW-Authenticate: Payment` header.
 *
 * Optionally includes RFC 9457 Problem Details in the response body when an error is provided.
 *
 * @param parameters - The challenge and optional error.
 * @returns A 402 Response suitable for returning from a route handler.
 *
 * @example
 * ```ts
 * import { Challenge } from 'mppx'
 * import { Response } from 'mppx/server'
 *
 * const challenge = Challenge.from({ id: '...', realm: 'api.example.com', method: 'tempo', intent: 'charge', request: { ... } })
 * return Response.requirePayment({ challenge })
 * ```
 */
export function requirePayment(parameters: requirePayment.Parameters): Response {
  const { challenge, error } = parameters

  const headers: Record<string, string> = {
    'WWW-Authenticate': Challenge.serialize(challenge),
    'Cache-Control': 'no-store',
  }

  let body: string | null = null

  if (error) {
    headers['Content-Type'] = 'application/problem+json'
    body = JSON.stringify(error.toProblemDetails(challenge.id))
  }

  return new Response(body, { status: 402, headers })
}

export declare namespace requirePayment {
  type Parameters = {
    challenge: Challenge.Challenge
    error?: Errors.PaymentError | undefined
  }
}
