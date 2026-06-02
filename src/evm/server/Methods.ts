import type { NoExtraKeys } from '../../internal/types.js'
import * as Assets from '../Assets.js'
import * as Chains from '../Chains.js'
import { charge as charge_ } from './Charge.js'

/** Creates EVM server methods from shared charge parameters. */
export function evm<const parameters extends evm.Parameters>(
  parameters: NoExtraKeys<parameters, evm.Parameters>,
) {
  return [evm.charge(parameters)] as const
}

export namespace evm {
  export type Parameters = charge_.Parameters

  /** Creates an EVM `charge` server method. */
  export const charge = charge_
  /** Known EVM asset metadata for public config. */
  export const assets = Assets
  /** Common EVM chain IDs for public config. */
  export const chains = Chains
}
