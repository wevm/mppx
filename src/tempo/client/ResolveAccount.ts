import type { Account as ViemAccount, Address } from 'viem'

import type * as Challenge from '../../Challenge.js'
import type { MaybePromise } from '../../internal/types.js'
import type * as Account from '../../viem/Account.js'
import type * as AutoSwap from '../internal/auto-swap.js'
import type * as Methods from '../Methods.js'
import type { ChannelEntry } from '../session/client/ChannelOps.js'
import type { DescriptorSessionContext, SessionContext } from '../session/client/CredentialState.js'

type ChargeRequest = ReturnType<typeof Methods.charge.schema.request.parse>
type SessionRequest = ReturnType<typeof Methods.session.schema.request.parse>

/** Runtime context accepted by the Tempo charge client method. */
export type ChargeContext = {
  account?: Account.getResolver.Parameters['account'] | undefined
  autoSwap?: AutoSwap.resolve.Value | undefined
  mode?: Methods.ChargeMode | undefined
}

type BaseInfo<intent extends 'charge' | 'session', request> = {
  /** Default account resolved from method parameters and credential context. */
  account: ViemAccount
  /** EVM chain ID used for signing. */
  chainId: number
  /** Deserialized 402 challenge being answered. */
  challenge: Challenge.Challenge<request, intent, 'tempo'>
  /** Tempo payment intent being answered. */
  intent: intent
}

/** Account-resolution details for a Tempo charge credential. */
export type ResolveChargeAccountInfo = BaseInfo<'charge', ChargeRequest> & {
  context?: ChargeContext | undefined
  request: ChargeRequest
  supportedModes: readonly Methods.ChargeMode[]
}

/** Account-resolution details for a TIP-1034 session credential. */
export type ResolveSessionAccountInfo = BaseInfo<'session', SessionRequest> & {
  context?: SessionContext | undefined
  entry?: ChannelEntry | undefined
  escrow: Address
  key: string
  payee: Address
  payer: Address
  recoverContext?: DescriptorSessionContext | undefined
  request: SessionRequest
  token: Address
}

/** Account-resolution details for Tempo client credentials. */
export type ResolveAccountInfo = ResolveChargeAccountInfo | ResolveSessionAccountInfo

/** Resolves the account that should sign a Tempo protocol credential. */
export type ResolveAccount = (info: ResolveAccountInfo) => MaybePromise<ViemAccount | undefined>
