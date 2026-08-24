import type { Account, Address } from 'viem'
import type { Account as TempoAccount } from 'viem/tempo'

import * as HostedFeePayer from './hosted-fee-payer.js'

/** Returns whether an account is a Tempo access-key account. */
export function isAccessKeyAccount(
  account: Account,
): account is Account & TempoAccount.AccessKeyAccount {
  return 'accessKeyAddress' in account
}

/** Returns the address that should authorize direct account signatures. */
export function getAccountSignerAddress(account: Account): Address {
  return isAccessKeyAccount(account) ? account.accessKeyAddress : account.address
}

/**
 * Resolves a recipient address and optional fee payer from flexible input parameters.
 *
 * Accepts either `account` or `recipient` as the parameter name. When the value
 * is an `Account`, its address is extracted. If `feePayer` is `true`, the
 * account also acts as the fee payer. Alternatively, a separate `Account`
 * can be provided as the fee payer, or hosted fee-payer configuration (used
 * with `withFeePayer` transport wrapping).
 *
 * @returns Resolved account, local fee payer, hosted fee payer, and recipient.
 */
export function resolve(parameters: resolve.Parameters) {
  const feePayerInput = parameters.feePayer
  const account = (() => {
    if (typeof parameters.account === 'object') return parameters.account
    return undefined
  })()
  const recipient = (() => {
    if (parameters.recipient) return parameters.recipient
    if (typeof parameters.account === 'object') return parameters.account.address
    return parameters.account
  })()
  const hostedFeePayer = HostedFeePayer.from(feePayerInput)
  const feePayer = ((): Account | undefined => {
    if (typeof parameters.account === 'object' && feePayerInput === true) return parameters.account
    if (typeof feePayerInput === 'object' && !HostedFeePayer.is(feePayerInput)) return feePayerInput
    return undefined
  })()
  return { account, feePayer, hostedFeePayer, recipient: recipient as Address | undefined }
}

export declare namespace resolve {
  type Parameters = {
    recipient?: Address | undefined
    /** Account or address that performs payment operations / receives payment. */
    account?: Account | Address | undefined
    /** When `true`, the account also sponsors fees. An `Account` or hosted fee-payer configuration can also be provided. */
    feePayer?: Account | HostedFeePayer.Config | string | true | undefined
  }
}
