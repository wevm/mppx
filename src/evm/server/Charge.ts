import { exact as x402_exact } from '../../x402/server/Exact.js'
import type * as x402_Types from '../../x402/Types.js'

/**
 * Creates an EVM charge server method.
 *
 * When `x402` is configured, the method speaks x402 exact on the wire while
 * exposing the user-facing MPP method as `evm/charge`.
 */
export function charge<const parameters extends charge.Parameters>(parameters: parameters) {
  const { x402, ...config } = parameters
  return x402_exact({
    config: {
      ...config,
      facilitator: x402.facilitator,
    },
  } as x402_exact.Parameters)
}

export declare namespace charge {
  type Parameters = Omit<x402_exact.Config, 'facilitator'> & {
    /** x402 adapter configuration for exact EVM settlement. */
    x402: {
      /** Facilitator client or base URL. */
      facilitator: string | x402_Types.Facilitator
    }
  }

  type RouteOptions = x402_exact.RouteOptions
}
