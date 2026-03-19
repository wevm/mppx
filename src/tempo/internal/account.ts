import type { Account, Address } from 'viem'

/**
 * Resolves a recipient address and optional fee payer from flexible input parameters.
 *
 * Accepts either `account` or `recipient` as the parameter name. When the value
 * is an `Account`, its address is extracted. If `feePayer` is `true`, the
 * account also acts as the fee payer. Alternatively, a separate `Account`
 * can be provided as the fee payer, or a URL string pointing to a fee payer
 * relay service (used with `withFeePayer` transport wrapping).
 *
 * @returns An object with `account`, `feePayer`, `feePayerUrl`, and `recipient`.
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
  const feePayerUrl = typeof parameters.feePayer === 'string' ? parameters.feePayer : undefined
  const feePayer = (() => {
    if (typeof parameters.feePayer === 'string') return undefined
    if (typeof parameters.account === 'object' && parameters.feePayer === true)
      return parameters.account
    if (typeof parameters.feePayer === 'object') return parameters.feePayer
    return undefined
  })()
  return { account, feePayer, feePayerUrl, recipient: recipient as Address | undefined }
}

export declare namespace resolve {
  type Parameters = {
    recipient?: Address | undefined
    /** Account or address that performs payment operations / receives payment. */
    account?: Account | Address | undefined
    /** When `true`, the account also sponsors fees. An `Account` object or URL string can also be provided as a dedicated fee payer. */
    feePayer?: Account | string | true | undefined
  }
}
