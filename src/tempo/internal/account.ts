import type { Account, Address } from 'viem'
import type { Account as TempoAccount } from 'viem/tempo'

import * as RemoteFeePayer from './remote-fee-payer.js'

/** Returns whether a value is a viem account. */
export function is(value: unknown): value is Account {
  return typeof value === 'object' && value !== null && 'address' in value
}

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
 * can be provided as the fee payer, or remote fee-payer configuration (used
 * with `withFeePayer` transport wrapping).
 *
 * @returns Resolved account, local fee payer, remote fee payer, and recipient.
 */
export function resolve(parameters: resolve.Parameters) {
  const account = is(parameters.account) ? parameters.account : undefined
  const recipient = parameters.recipient ?? account?.address ?? parameters.account
  const remoteFeePayer = RemoteFeePayer.from(parameters.feePayer)
  const feePayer =
    parameters.feePayer === true
      ? account
      : is(parameters.feePayer)
        ? parameters.feePayer
        : undefined
  return { account, feePayer, remoteFeePayer, recipient: recipient as Address | undefined }
}

export declare namespace resolve {
  type Parameters = {
    recipient?: Address | undefined
    /** Account or address that performs payment operations / receives payment. */
    account?: Account | Address | undefined
    /**
     * When `true`, the account also sponsors fees. An `Account` or remote fee-payer
     * configuration can also be provided. A string is shorthand for its URL.
     */
    feePayer?: Account | RemoteFeePayer.Config | string | true | undefined
  }
}
