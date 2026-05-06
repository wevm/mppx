import { charge } from './Charge.js'

export function evm(parameters: evm.Parameters) {
  return [charge(parameters)] as const
}

export declare namespace evm {
  type Parameters = charge.Parameters
}
