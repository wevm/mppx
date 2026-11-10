import { BaseError, ExecutionRevertedError } from 'viem'

import { ChallengeUnpayableError } from '../../Errors.js'
import { InsufficientFundsError } from './auto-swap.js'

/**
 * Runs a step that simulates a payment before anything is signed, such as preparing its
 * transaction, and reports a revert or missing funds as `ChallengeUnpayableError` so automatic
 * payment can try another offer. Other failures, such as an unreachable node, are rethrown as is.
 */
export async function simulate<result>(step: () => Promise<result>): Promise<result> {
  try {
    return await step()
  } catch (error) {
    if (isUnpayable(error)) throw new ChallengeUnpayableError({ cause: error })
    throw error
  }
}

function isUnpayable(error: unknown): boolean {
  if (error instanceof InsufficientFundsError) return true
  return (
    error instanceof BaseError &&
    error.walk((cause) => cause instanceof ExecutionRevertedError) instanceof ExecutionRevertedError
  )
}
