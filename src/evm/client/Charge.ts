import { exact as x402_exact } from '../../x402/client/Exact.js'

/**
 * Creates an EVM charge client method.
 *
 * The client signs x402 exact EIP-3009 credentials when an x402 exact offer is
 * selected for the `evm/charge` route.
 */
export function charge(parameters: charge.Parameters) {
  return x402_exact(parameters)
}

export declare namespace charge {
  type Parameters = x402_exact.Parameters
}
