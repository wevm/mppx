import type { Account, Address } from 'viem'

/**
 * Resolves a recipient address and optional server account from flexible input
 * parameters.  When `account` is an `Account` object its address is used as the
 * default recipient (the address that receives settlement payments).
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
  return { account, recipient: recipient as Address | undefined }
}

export declare namespace resolve {
  type Parameters = {
    /** Address that receives settlement payments. */
    recipient?: Address | undefined
  } & {
    /**
     * Server-side account used to broadcast permit + transferFrom transactions.
     * When provided as an `Account`, its address doubles as the default recipient.
     * When provided as a plain `Address`, only used as the recipient.
     */
    account?: Account | Address | undefined
  }
}
