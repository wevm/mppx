import * as Assets from '../Assets.js'
import { exact as exact_ } from './Exact.js'
import * as Transport_ from './Transport.js'

/** Creates x402 server methods from shared parameters. */
export function x402<const parameters extends x402.Parameters>(parameters: parameters) {
  return [x402.exact(parameters)] as const
}

export namespace x402 {
  export type Parameters = exact_.Parameters

  /** Creates an x402 `exact` server method. */
  export const exact = exact_
  /** Known x402 asset metadata for public config. */
  export const assets = Assets
  /** x402 server transports. */
  export const Transport = Transport_
}
