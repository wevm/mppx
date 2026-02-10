import type { Account, Address } from 'viem'

/**
 * Resolves a recipient address and optional fee payer from flexible input parameters.
 *
 * When `recipient` is an `Account`, its address is extracted. If `feePayer` is `true`,
 * the recipient account also acts as the fee payer. Alternatively, a separate `Account`
 * can be provided as the fee payer.
 *
 * @returns A tuple of `[recipientAddress, feePayerAccount]`.
 */
export function resolve(parameters: resolve.Parameters) {
  const recipient = (() => {
    if (typeof parameters.recipient === 'object') return parameters.recipient.address
    return parameters.recipient
  })()
  const feePayer = (() => {
    if (typeof parameters.recipient === 'object' && parameters.feePayer === true)
      return parameters.recipient
    if (typeof parameters.feePayer === 'object') return parameters.feePayer
    return undefined
  })()
  return [recipient as Address | undefined, feePayer] as const
}

export declare namespace resolve {
  type Parameters =
    | {
        /** Recipient account. Address is used as the payment recipient. */
        recipient?: Account | undefined
        /** When true, the recipient account also sponsors (pays) transaction fees. */
        feePayer?: true | undefined
      }
    | {
        /** Address that receives payment. */
        recipient?: string | undefined
        /** Optional fee payer account for covering transaction fees. */
        feePayer?: Account | undefined
      }
}
