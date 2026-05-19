import type { Hex } from 'viem'

import type { Receipt } from './Types.js'

/** Creates a Tempo authorize capture receipt. */
export function create(parameters: {
  authorizationId: Hex
  capturedAmount: bigint
  delta: bigint
  reference: Hex
  timestamp?: Date | undefined
}): Receipt {
  return {
    authorizationId: parameters.authorizationId,
    capturedAmount: parameters.capturedAmount.toString(),
    delta: parameters.delta.toString(),
    intent: 'authorize',
    method: 'tempo',
    reference: parameters.reference,
    status: 'success',
    timestamp: (parameters.timestamp ?? new Date()).toISOString(),
  }
}
