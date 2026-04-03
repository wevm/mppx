/**
 * Shared client-side channel operations.
 *
 * Provides the low-level helpers that both `session()`
 * and `sessionManager()` (orchestrator) rely on: escrow resolution, channel
 * ID computation, on-chain open/voucher/close payload construction, channel
 * recovery from on-chain state, and credential serialization.
 */
import { Hex } from 'ox'
import {
  type Address,
  encodeFunctionData,
  type Account as viem_Account,
  type Client as viem_Client,
} from 'viem'
import { prepareTransactionRequest, signTransaction } from 'viem/actions'
import { Abis } from 'viem/tempo'

import type { Challenge } from '../../Challenge.js'
import * as Credential from '../../Credential.js'
import * as defaults from '../internal/defaults.js'
import { escrowAbi, getOnChainChannel } from '../session/Chain.js'
import * as Channel from '../session/Channel.js'
import type { SessionCredentialPayload } from '../session/Types.js'
import { signVoucher } from '../session/Voucher.js'

export type ChannelEntry = {
  channelId: Hex.Hex
  salt: Hex.Hex
  cumulativeAmount: bigint
  escrowContract: Address
  chainId: number
  opened: boolean
}

export function resolveChainId(challenge: Challenge): number {
  const md = challenge.request.methodDetails as { chainId?: number } | undefined
  return md?.chainId ?? 0
}

export function resolveEscrow(
  challenge: { request: { methodDetails?: unknown } },
  chainId: number,
  escrowContractOverride?: Address,
): Address {
  const challengeEscrow = (challenge.request.methodDetails as { escrowContract?: string })
    ?.escrowContract as Address | undefined
  const escrow =
    challengeEscrow ??
    escrowContractOverride ??
    defaults.escrowContract[chainId as keyof typeof defaults.escrowContract]
  if (!escrow)
    throw new Error(
      'No `escrowContract` available. Provide it in parameters or ensure the server challenge includes it.',
    )
  return escrow
}

export function serializeCredential(
  challenge: Challenge,
  payload: SessionCredentialPayload,
  chainId: number,
  account: viem_Account,
): string {
  return Credential.serialize({
    challenge,
    payload,
    source: `did:pkh:eip155:${chainId}:${account.address}`,
  })
}

export async function createVoucherPayload(
  client: viem_Client,
  account: viem_Account,
  channelId: Hex.Hex,
  cumulativeAmount: bigint,
  escrowContract: Address,
  chainId: number,
  authorizedSigner?: Address | undefined,
): Promise<SessionCredentialPayload> {
  const signature = await signVoucher(
    client,
    account,
    { channelId, cumulativeAmount },
    escrowContract,
    chainId,
    authorizedSigner,
  )
  return {
    action: 'voucher',
    channelId,
    cumulativeAmount: cumulativeAmount.toString(),
    signature,
  }
}

export async function createClosePayload(
  client: viem_Client,
  account: viem_Account,
  channelId: Hex.Hex,
  cumulativeAmount: bigint,
  escrowContract: Address,
  chainId: number,
  authorizedSigner?: Address | undefined,
): Promise<SessionCredentialPayload> {
  const signature = await signVoucher(
    client,
    account,
    { channelId, cumulativeAmount },
    escrowContract,
    chainId,
    authorizedSigner,
  )
  return {
    action: 'close',
    channelId,
    cumulativeAmount: cumulativeAmount.toString(),
    signature,
  }
}

export async function createOpenPayload(
  client: viem_Client,
  account: viem_Account,
  options: {
    authorizedSigner?: Address | undefined
    escrowContract: Address
    payee: Address
    currency: Address
    deposit: bigint
    initialAmount: bigint
    chainId: number
    feePayer?: boolean | undefined
  },
): Promise<{ entry: ChannelEntry; payload: SessionCredentialPayload }> {
  const { escrowContract, payee, currency, deposit, initialAmount, chainId, feePayer } = options
  const authorizedSigner = options.authorizedSigner ?? account.address

  const salt = Hex.random(32)
  const channelId = Channel.computeId({
    authorizedSigner,
    chainId,
    escrowContract,
    payee,
    payer: account.address,
    salt,
    token: currency,
  })

  const approveData = encodeFunctionData({
    abi: Abis.tip20,
    functionName: 'approve',
    args: [escrowContract, deposit],
  })
  const openData = encodeFunctionData({
    abi: escrowAbi,
    functionName: 'open',
    args: [payee, currency, deposit, salt, authorizedSigner],
  })

  const prepared = await prepareTransactionRequest(client, {
    account,
    calls: [
      { to: currency, data: approveData },
      { to: escrowContract, data: openData },
    ],
    ...(feePayer && { feePayer: true }),
    feeToken: currency,
  } as never)
  prepared.gas = prepared.gas! + 5_000n
  const transaction = (await signTransaction(client, prepared as never)) as Hex.Hex

  const signature = await signVoucher(
    client,
    account,
    { channelId, cumulativeAmount: initialAmount },
    escrowContract,
    chainId,
    options.authorizedSigner,
  )

  return {
    entry: {
      channelId,
      salt,
      cumulativeAmount: initialAmount,
      escrowContract,
      chainId,
      opened: true,
    },
    payload: {
      action: 'open',
      type: 'transaction',
      channelId,
      transaction,
      authorizedSigner,
      cumulativeAmount: initialAmount.toString(),
      signature,
    },
  }
}

/**
 * Attempt to recover an existing on-chain channel by reading its state.
 *
 * If the channel has a positive deposit and is not finalized, returns a
 * {@link ChannelEntry} with `cumulativeAmount` set to the on-chain settled
 * amount (the safe starting point for new vouchers).
 *
 * Returns `undefined` if the channel doesn't exist, has zero deposit,
 * is already finalized, or lacks enough available balance.
 */
export async function tryRecoverChannel(
  client: viem_Client,
  escrowContract: Address,
  channelId: Hex.Hex,
  chainId: number,
  minAvailable?: bigint,
): Promise<ChannelEntry | undefined> {
  try {
    const onChain = await getOnChainChannel(client, escrowContract, channelId)

    if (onChain.deposit > 0n && !onChain.finalized) {
      if (minAvailable !== undefined && onChain.deposit - onChain.settled < minAvailable)
        return undefined

      return {
        channelId,
        salt: '0x' as Hex.Hex,
        cumulativeAmount: onChain.settled,
        escrowContract,
        chainId,
        opened: true,
      }
    }
  } catch {}

  return undefined
}
