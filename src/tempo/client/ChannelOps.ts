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
import type {
  SessionChallengeMethodDetails,
  SessionCredentialPayload,
  SessionReceipt,
} from '../session/Types.js'
import { signVoucher } from '../session/Voucher.js'

export type ChannelEntry = {
  /** Highest voucher amount observed from server accounting hints or receipts. */
  acceptedCumulative: bigint
  chainId: number
  channelId: Hex.Hex
  /** Highest cumulative amount the client itself has signed for this channel. */
  cumulativeAmount: bigint
  /** Latest known deposit ceiling. */
  deposit?: bigint | undefined
  escrowContract: Address
  opened: boolean
  salt: Hex.Hex
  /** Latest server-reported spent amount for the session. */
  spent: bigint
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

/**
 * Server-provided advisory channel state from receipts or hints.
 *
 * Values are monotonically reconciled into the local {@link ChannelEntry} —
 * only upward adjustments are applied. These are **never** used directly for
 * signing authorization; they inform the client's view of server-side
 * accounting only.
 */
type ChannelSnapshot = {
  /** Server-acknowledged cumulative voucher amount. */
  acceptedCumulative?: bigint | string | undefined
  /** Current on-chain deposit as observed by the server. */
  deposit?: bigint | string | undefined
  /** Cumulative amount the server considers consumed. */
  spent?: bigint | string | undefined
}

function toBigInt(value: bigint | string): bigint {
  return typeof value === 'bigint' ? value : BigInt(value)
}

function maxBigInt(current: bigint, next: bigint): bigint {
  return current > next ? current : next
}

export function createHintedChannelEntry(options: {
  chainId: number
  channelId: Hex.Hex
  escrowContract: Address
  hints: Pick<SessionChallengeMethodDetails, 'acceptedCumulative' | 'deposit' | 'spent'>
}): ChannelEntry {
  const spent = BigInt(options.hints.spent ?? options.hints.acceptedCumulative ?? '0')
  const acceptedCumulative = maxBigInt(BigInt(options.hints.acceptedCumulative ?? '0'), spent)

  return {
    acceptedCumulative,
    chainId: options.chainId,
    channelId: options.channelId,
    // Hints are advisory only. Start signing from locally authorized state.
    cumulativeAmount: 0n,
    ...(options.hints.deposit !== undefined && { deposit: BigInt(options.hints.deposit) }),
    escrowContract: options.escrowContract,
    opened: true,
    salt: '0x' as Hex.Hex,
    spent,
  }
}

export function reconcileChannelEntry(entry: ChannelEntry, snapshot: ChannelSnapshot): boolean {
  let changed = false

  if (snapshot.acceptedCumulative !== undefined) {
    const acceptedCumulative = toBigInt(snapshot.acceptedCumulative)
    if (acceptedCumulative > entry.acceptedCumulative) {
      entry.acceptedCumulative = acceptedCumulative
      changed = true
    }
  }

  if (snapshot.spent !== undefined) {
    const spent = toBigInt(snapshot.spent)
    if (spent > entry.spent) {
      entry.spent = spent
      changed = true
    }
    if (snapshot.acceptedCumulative === undefined && entry.acceptedCumulative < spent) {
      entry.acceptedCumulative = spent
      changed = true
    }
  }

  if (snapshot.deposit !== undefined) {
    const deposit = toBigInt(snapshot.deposit)
    if (entry.deposit === undefined || deposit > entry.deposit) {
      entry.deposit = deposit
      changed = true
    }
  }

  return changed
}

export function reconcileChannelReceipt(entry: ChannelEntry, receipt: SessionReceipt): boolean {
  return reconcileChannelEntry(entry, {
    acceptedCumulative: receipt.acceptedCumulative,
    spent: receipt.spent,
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
      acceptedCumulative: initialAmount,
      chainId,
      channelId,
      cumulativeAmount: initialAmount,
      deposit,
      escrowContract,
      opened: true,
      salt,
      spent: 0n,
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
 * or is already finalized.
 */
export async function tryRecoverChannel(
  client: viem_Client,
  escrowContract: Address,
  channelId: Hex.Hex,
  chainId: number,
): Promise<ChannelEntry | undefined> {
  try {
    const onChain = await getOnChainChannel(client, escrowContract, channelId)

    if (onChain.deposit > 0n && !onChain.finalized) {
      return {
        acceptedCumulative: onChain.settled,
        chainId,
        channelId,
        cumulativeAmount: onChain.settled,
        deposit: onChain.deposit,
        escrowContract,
        opened: true,
        salt: '0x' as Hex.Hex,
        spent: onChain.settled,
      }
    }
  } catch {}

  return undefined
}
