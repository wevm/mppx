import type { Account, Address } from 'viem'

import { defaultFeeTokens, resolveFundedFeeToken } from '../../internal/fee-token.js'
import * as MachineTokenCharge from '../../internal/machine-token-charge.js'
import { isSameAddress } from './ChannelOps.js'
import { channelKey, type ChannelStore } from './ChannelStore.js'
import type { ChallengeContext, SessionContext } from './CredentialState.js'

/**
 * Returns the context for funding a `machineTokenAccepted` challenge's channel in MACH, 1:1 with the
 * challenge currency, or `undefined` when the challenge does not accept MACH. MACH cannot pay fees,
 * so its transactions pay them in the server's fee token or the challenge currency.
 */
export function resolveMachineTokenContext(
  resolved: ChallengeContext,
): ChallengeContext | undefined {
  if (!resolved.machineTokenAccepted) return undefined
  const token = MachineTokenCharge.getToken(resolved.chainId)
  if (!token || isSameAddress(token, resolved.token)) return undefined
  return {
    ...resolved,
    feeToken: resolved.feeToken ?? resolved.token,
    key: channelKey({
      chainId: resolved.chainId,
      escrow: resolved.escrow,
      payee: resolved.payee,
      token,
    }),
    token,
  }
}

/**
 * Selects the channel a challenge pays from: for a `machineTokenAccepted` challenge, a MACH channel when
 * the caller's descriptor, the stored channels or the server's snapshot point to one. A stored channel
 * in the challenge currency is kept, so the MACH preference never opens a second channel. Other
 * challenges resolve unchanged, without store reads.
 */
export async function selectChannelContext(parameters: {
  context?: SessionContext | undefined
  resolved: ChallengeContext
  store: ChannelStore
}): Promise<ChallengeContext> {
  const { context, resolved, store } = parameters
  const machine = resolveMachineTokenContext(resolved)
  if (!machine) return resolved
  if (context?.descriptor)
    return isSameAddress(context.descriptor.token, machine.token) ? machine : resolved
  if (await store.get(resolved.key)) return resolved
  if (await store.get(machine.key)) return machine
  if (resolved.snapshot && isSameAddress(resolved.snapshot.descriptor.token, machine.token))
    return machine
  return resolved
}

/**
 * Returns the context to open a `machineTokenAccepted` challenge's channel in MACH when the account's MACH
 * balance covers the deposit and, for an access key that limits spending, its remaining MACH limit
 * does too. Any failed read returns `undefined`, so the channel opens in the challenge currency.
 */
export async function resolveMachineTokenOpen(parameters: {
  account: Account
  deposit: bigint
  resolved: ChallengeContext
}): Promise<ChallengeContext | undefined> {
  const { account, deposit, resolved } = parameters
  const machine = resolveMachineTokenContext(resolved)
  if (!machine) return undefined
  if (
    !(await MachineTokenCharge.canSpend(resolved.client, {
      account,
      amount: deposit,
      token: machine.token,
    }))
  )
    return undefined
  if (machine.feePayer) return machine
  // MACH cannot pay fees: an unsponsored payer without a stablecoin for gas opens in the challenge
  // currency instead.
  const feeToken = await findFeeToken({ account, resolved: machine })
  return feeToken ? { ...machine, feeToken } : undefined
}

/**
 * Returns the fee token for a transaction funding a MACH channel accepted for a
 * `machineTokenAccepted` challenge. MACH cannot pay fees, so an unsponsored payer pays them in the
 * server's fee token, or else in the challenge currency or a default stablecoin it holds. Other
 * channels keep their resolved fee token.
 */
export async function resolveMachineTokenFeeToken(parameters: {
  account: Account
  resolved: ChallengeContext
}): Promise<Address | undefined> {
  const { account, resolved } = parameters
  const { chainId } = resolved
  const currency = resolved.challenge.request.currency as Address
  if (
    !MachineTokenCharge.isMachineToken({ chainId, currency: resolved.token }) ||
    MachineTokenCharge.isMachineToken({ chainId, currency })
  )
    return resolved.feeToken
  if (resolved.feePayer) return resolved.feeToken
  return (await findFeeToken({ account, resolved })) ?? resolved.feeToken ?? currency
}

/** Returns the server's fee token, or else the challenge currency or a default stablecoin, when the payer holds it. */
async function findFeeToken(parameters: {
  account: Account
  resolved: ChallengeContext
}): Promise<Address | undefined> {
  const { account, resolved } = parameters
  const { chainId, challenge, client } = resolved
  const feeToken = (challenge.request.methodDetails as { feeToken?: unknown } | undefined)?.feeToken
  return resolveFundedFeeToken({
    account: account.address,
    chainId,
    client,
    preferred:
      typeof feeToken === 'string'
        ? [feeToken as Address]
        : [challenge.request.currency as Address, ...defaultFeeTokens(chainId)],
  })
}

/**
 * Returns the scopes an automatic open locks: the challenge currency's and, for a
 * `machineTokenAccepted` challenge, the MACH channel's too. The open may land on either, so locking
 * both keeps concurrent opens from funding two channels in the same scope.
 */
export function getLockKeys(resolved: ChallengeContext): readonly string[] {
  const machineTokenKey = resolveMachineTokenContext(resolved)?.key
  return machineTokenKey ? [resolved.key, machineTokenKey] : [resolved.key]
}
