import type { Account, Address } from 'viem'

/**
 * Resolves a recipient address and optional fee payer from flexible input parameters.
 *
 * Accepts either `account` or `recipient` as the parameter name. When the value
 * is an `Account`, its address is extracted. If `feePayer` is `true`, the
 * account also acts as the fee payer. Alternatively, a separate `Account`
 * can be provided as the fee payer.
 *
 * @returns An object with `account`, `feePayer`, and `recipient`.
 */
export function resolve(parameters: resolve.Parameters) {
  const account = (() => {
    if (typeof parameters.account === 'object') return parameters.account
    return undefined
  })()
  const recipient = (() => {
    if (parameters.recipient) return parameters.recipient
    if (typeof parameters.account === 'object') return parameters.account.address
    return parameters.account
  })()
  const feePayer = (() => {
    if (typeof parameters.account === 'object' && parameters.feePayer === true)
      return parameters.account
    if (typeof parameters.feePayer === 'object') return parameters.feePayer
    return undefined
  })()
  return { account, feePayer, recipient: recipient as Address | undefined }
}

export declare namespace resolve {
  type Parameters = { recipient?: Address | undefined } & (
    | {
        /** Account that performs payment operations. */
        account?: Account | undefined
        /** When true, the account also sponsors (pays) transaction fees. */
        feePayer?: true | undefined
      }
    | {
        /** Address that receives payment. */
        account?: Address | undefined
        /** Optional fee payer account for covering transaction fees. */
        feePayer?: Account | undefined
      }
  )
}
