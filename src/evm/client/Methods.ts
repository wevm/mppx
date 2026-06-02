import * as Assets from '../Assets.js'
import * as Chains from '../Chains.js'
import { charge as charge_ } from './Charge.js'

/** Creates EVM client methods from shared charge parameters. */
export function evm(parameters: evm.Parameters) {
  return [evm.charge(parameters)] as const
}

export namespace evm {
  export type Parameters = charge_.Parameters

  /** Creates an EVM `charge` client method. */
  export const charge = charge_
  /** Known EVM asset metadata for public config. */
  export const assets = Assets
  /** Common EVM chain IDs for public config. */
  export const chains = Chains
}
