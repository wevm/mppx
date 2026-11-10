import type { Account, Address, Client } from 'viem'
import { readContract } from 'viem/actions'
import { Actions } from 'viem/tempo'

import * as defaults from '../../internal/defaults.js'
import { defaultFeeTokens, resolveFeeToken } from '../../internal/fee-token.js'
import { isSameAddress } from './ChannelOps.js'
import { channelKey, type ChannelStore } from './ChannelStore.js'
import type { ChallengeContext, SessionContext } from './CredentialState.js'

function getMachineToken(chainId: number): Address | undefined {
  return defaults.machineToken[chainId as keyof typeof defaults.machineToken]?.token
}

function isMachineTokenDirect(resolved: ChallengeContext): boolean {
  const methodDetails = resolved.challenge.request.methodDetails
  return (
    typeof methodDetails === 'object' &&
    methodDetails !== null &&
    (methodDetails as { machineTokenDirect?: unknown }).machineTokenDirect === true
  )
}

/** Returns whether a token is MACH on a chain. */
export function isMachineToken(chainId: number, token: Address): boolean {
  const machineToken = getMachineToken(chainId)
  return machineToken !== undefined && isSameAddress(machineToken, token)
}

/**
 * Returns the context for funding a `machineTokenDirect` challenge's channel in MACH, 1:1 with the
 * challenge currency, or `undefined` when the challenge does not accept MACH. MACH cannot pay fees,
 * so its transactions pay them in the server's fee token or the challenge currency.
 */
export function resolveMachineTokenContext(
  resolved: ChallengeContext,
): ChallengeContext | undefined {
  if (!isMachineTokenDirect(resolved)) return undefined
  const token = getMachineToken(resolved.chainId)
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
 * Selects the channel a challenge pays from: for a `machineTokenDirect` challenge, a MACH channel when
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
 * Returns the context to open a `machineTokenDirect` challenge's channel in MACH when the account's MACH
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
  if (!(await canSpend(resolved.client, account, machine.token, deposit))) return undefined
  return { ...machine, feeToken: await resolveMachineTokenFeeToken({ account, resolved: machine }) }
}

/**
 * Returns the fee token for a transaction funding a MACH channel accepted for a
 * `machineTokenDirect` challenge. MACH cannot pay fees, so an unsponsored payer pays them in the
 * server's fee token, or else in the challenge currency or a default stablecoin it holds. Other
 * channels keep their resolved fee token.
 */
export async function resolveMachineTokenFeeToken(parameters: {
  account: Account
  resolved: ChallengeContext
}): Promise<Address | undefined> {
  const { account, resolved } = parameters
  const currency = resolved.challenge.request.currency as Address
  if (
    !isMachineToken(resolved.chainId, resolved.token) ||
    isMachineToken(resolved.chainId, currency)
  )
    return resolved.feeToken
  if (resolved.feePayer) return resolved.feeToken
  const methodDetails = resolved.challenge.request.methodDetails as
    | { feeToken?: unknown }
    | undefined
  if (typeof methodDetails?.feeToken === 'string') return methodDetails.feeToken as Address
  const feeTokens = [currency, ...defaultFeeTokens(resolved.chainId)]
  const feeToken = await resolveFeeToken({
    account: account.address,
    allowedTokens: feeTokens,
    candidateTokens: feeTokens,
    client: resolved.client,
    prioritizeCandidates: true,
  })
  return feeToken ?? currency
}

/**
 * Returns the payment-scope keys an automatic open must hold: the challenge currency's and, for a
 * `machineTokenDirect` challenge, the MACH channel's, which offers in other currencies share.
 */
export function getOpenScopes(resolved: ChallengeContext): readonly string[] {
  const machine = resolveMachineTokenContext(resolved)
  return machine ? [resolved.key, machine.key] : [resolved.key]
}

async function canSpend(
  client: Client,
  account: Account,
  token: Address,
  amount: bigint,
): Promise<boolean> {
  try {
    const balance = (await readContract(
      client,
      Actions.token.getBalance.call(client, { account: account.address, token }) as never,
    )) as bigint
    if (balance < amount) return false
    const accessKey = (account as { accessKeyAddress?: unknown }).accessKeyAddress
    if (typeof accessKey !== 'string') return true
    const metadata = await Actions.accessKey.getMetadata(client, {
      account: account.address,
      accessKey: accessKey as Address,
    })
    if (metadata.spendPolicy !== 'limited') return true
    const { remaining } = await Actions.accessKey.getRemainingLimit(client, {
      account: account.address,
      accessKey: accessKey as Address,
      token,
    })
    return remaining >= amount
  } catch {
    return false
  }
}
