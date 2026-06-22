import type * as Hex from 'ox/Hex'
import type { Account, Address } from 'viem'

import type { MaybePromise } from '../../internal/types.js'

/** Resolves the account that should satisfy an mppx account operation. */
export type ResolveAccount = (info: ResolveAccountInfo) => MaybePromise<Account | undefined>

/** Account-resolution details for a client credential operation. */
export type ResolveAccountInfo = {
  /** Account mppx will use when the hook returns `undefined`. */
  account: Account
  /** EIP-155 chain ID used for the operation. */
  chainId: number
  /** Capability the selected account must satisfy. */
  operation: ResolveAccountOperation
}

/** Capability an mppx-selected account must satisfy. */
export type ResolveAccountOperation =
  | {
      kind: 'executeCalls'
      /**
       * Exact EVM calls the selected account will execute.
       *
       * Omitted when the calls depend on which account is selected, such as
       * account-balance-dependent auto-swap routing.
       */
      calls?: readonly ResolveAccountCall[] | undefined
    }
  | {
      kind: 'authorizePaymentChannel'
      /**
       * Signer required by an existing reusable channel. Omitted when opening
       * a new channel or when no existing channel has fixed a signer yet.
       */
      authority?: Address | undefined
    }

/** EVM call data used by account resolvers for scoped account selection. */
export type ResolveAccountCall = {
  /** Contract address being called. */
  to: Address
  /** Calldata being sent. */
  data: Hex.Hex
}
