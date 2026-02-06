import type { Address, Hex, WalletClient } from 'viem'
import type { Challenge, Credential } from '../../../index.js'
import * as Method from '../../../Method.js'
import * as defaults from '../../internal/defaults.js'
import * as Methods from '../../Method.js'
import { getOnChainChannel, type OnChainChannel, verifyTopUpTransaction } from '../Chain.js'
import { createStreamReceipt } from '../Receipt.js'
import type { ChannelState, ChannelStorage, SessionState } from '../Storage.js'
import type { SignedVoucher, StreamCredentialPayload, StreamReceipt } from '../Types.js'
import { parseVoucherFromPayload, verifyVoucher } from '../Voucher.js'

const streamMethod = Method.from({
  intents: { stream: Methods.tempo.intents.stream },
  name: 'tempo' as const,
})

/**
 * Creates a stream payment server using the mpay Method.toServer() pattern.
 *
 * @example
 * ```ts
 * import { Mpay, tempo } from 'mpay/server'
 *
 * const mpay = Mpay.create({
 *   methods: [
 *     tempo.stream({
 *       storage: myStorage,
 *       rpcUrl: 'https://rpc.moderato.tempo.xyz',
 *       recipient: '0x...',
 *       currency: '0x...',
 *       escrowContract: '0x...',
 *       chainId: 42431,
 *     }),
 *   ],
 *   realm: 'my-app',
 *   secretKey: '...',
 * })
 * ```
 */
export function stream(parameters: stream.Parameters) {
  const { storage, minVoucherDelta = 0n, walletClient, rpcUrl } = parameters

  const chainId = parameters.chainId ?? defaults.testnetChainId
  const escrowContract =
    parameters.escrowContract ??
    (defaults.escrowContract[chainId as keyof typeof defaults.escrowContract] as
      | Address
      | undefined)

  return Method.toServer(streamMethod, {
    defaults: {
      recipient: parameters.recipient,
      currency: parameters.currency,
      escrowContract,
      chainId,
    },

    async verify({ credential }) {
      const { challenge, payload } = credential as Credential.Credential<StreamCredentialPayload>

      const methodDetails = challenge.request.methodDetails as {
        escrowContract: Address
        chainId: number
      }

      let streamReceipt: StreamReceipt

      switch (payload.action) {
        case 'open':
          streamReceipt = await handleOpen(storage, rpcUrl, challenge, payload, methodDetails)
          break

        case 'topUp':
          streamReceipt = await handleTopUp(
            storage,
            rpcUrl,
            minVoucherDelta,
            challenge,
            payload,
            methodDetails,
          )
          break

        case 'voucher':
          streamReceipt = await handleVoucher(
            storage,
            rpcUrl,
            minVoucherDelta,
            challenge,
            payload,
            methodDetails,
          )
          break

        case 'close':
          streamReceipt = await handleClose(
            storage,
            rpcUrl,
            walletClient,
            challenge,
            payload,
            methodDetails,
          )
          break

        default:
          throw new Error(`Unknown action: ${(payload as { action: string }).action}`)
      }

      return streamReceipt
    },
  })
}

export declare namespace stream {
  type Parameters = {
    /** Storage backend for channel and session state. */
    storage: ChannelStorage
    /** RPC URL for on-chain verification. */
    rpcUrl: string
    /** Minimum voucher delta to accept (default: 0n). */
    minVoucherDelta?: bigint
    /** Optional wallet client for on-chain close transactions. */
    walletClient?: WalletClient
    /** Default recipient address. */
    recipient?: Address
    /** Default currency token address. */
    currency?: Address
    /** Default escrow contract address. */
    escrowContract?: Address
    /** Default chain ID. */
    chainId?: number
  }
}

/**
 * Atomically upsert a session with a new acceptedCumulative.
 *
 * Safe under concurrent requests: cumulative semantics mean the highest
 * acceptedCumulative always wins, and updateChannel's atomic callback
 * ensures highestVoucherAmount is monotonically increasing.
 */
function acceptVoucher(
  storage: ChannelStorage,
  challengeId: string,
  channelId: Hex,
  acceptedCumulative: bigint,
): Promise<SessionState | null> {
  return storage.updateSession(challengeId, (existing) => {
    const base: SessionState = existing ?? {
      challengeId,
      channelId,
      acceptedCumulative: 0n,
      spent: 0n,
      units: 0,
      createdAt: new Date(),
    }
    return { ...base, acceptedCumulative }
  })
}

/**
 * Validate on-chain channel state.
 */
function validateOnChainChannel(
  onChain: OnChainChannel,
  recipient: Address,
  currency: Address,
): void {
  if (onChain.deposit === 0n) {
    throw new Error('Channel not funded on-chain')
  }
  if (onChain.finalized) {
    throw new Error('Channel is finalized on-chain')
  }
  if (onChain.payee.toLowerCase() !== recipient.toLowerCase()) {
    throw new Error('On-chain payee does not match server destination')
  }
  if (onChain.token.toLowerCase() !== currency.toLowerCase()) {
    throw new Error('On-chain token does not match server token')
  }
}

/**
 * Shared logic for verifying an incremental voucher, updating channel state,
 * and creating a session. Used by both handleTopUp and handleVoucher.
 */
async function verifyAndAcceptVoucher(parameters: {
  storage: ChannelStorage
  minVoucherDelta: bigint
  challenge: Challenge.Challenge
  channel: ChannelState
  channelId: Hex
  voucher: SignedVoucher
  onChainDeposit: bigint
  methodDetails: { escrowContract: Address; chainId: number }
}): Promise<StreamReceipt> {
  const {
    storage,
    minVoucherDelta,
    challenge,
    channel,
    channelId,
    voucher,
    onChainDeposit,
    methodDetails,
  } = parameters

  if (voucher.cumulativeAmount > onChainDeposit) {
    throw new Error('Voucher amount exceeds on-chain deposit')
  }

  if (voucher.cumulativeAmount <= channel.highestVoucherAmount) {
    throw new Error('Voucher amount must be increasing')
  }

  const delta = voucher.cumulativeAmount - channel.highestVoucherAmount
  if (delta < minVoucherDelta) {
    throw new Error(`Voucher delta ${delta} below minimum ${minVoucherDelta}`)
  }

  const isValid = await verifyVoucher(
    methodDetails.escrowContract,
    methodDetails.chainId,
    voucher,
    channel.authorizedSigner,
  )

  if (!isValid) {
    throw new Error('Invalid voucher signature')
  }

  await storage.updateChannel(channelId, (current) => {
    if (!current) throw new Error('Channel not found')
    if (voucher.cumulativeAmount > current.highestVoucherAmount) {
      return {
        ...current,
        deposit: onChainDeposit,
        highestVoucherAmount: voucher.cumulativeAmount,
        highestVoucher: voucher,
      }
    }
    return { ...current, deposit: onChainDeposit }
  })

  const session = await acceptVoucher(storage, challenge.id, channelId, voucher.cumulativeAmount)
  if (!session) throw new Error('Failed to create session')

  return createStreamReceipt({
    challengeId: challenge.id,
    channelId,
    acceptedCumulative: voucher.cumulativeAmount,
    spent: session.spent,
    units: session.units,
  })
}

/**
 * Handle 'open' action - verify channel opening and initial voucher.
 */
async function handleOpen(
  storage: ChannelStorage,
  rpcUrl: string,
  challenge: Challenge.Challenge,
  payload: StreamCredentialPayload & { action: 'open' },
  methodDetails: { escrowContract: Address; chainId: number },
): Promise<StreamReceipt> {
  const voucher = parseVoucherFromPayload(
    payload.channelId,
    payload.cumulativeAmount,
    payload.voucherSignature,
  )

  const onChain = await getOnChainChannel(rpcUrl, methodDetails.escrowContract, payload.channelId)

  const recipient = challenge.request.recipient as Address
  const currency = challenge.request.currency as Address
  validateOnChainChannel(onChain, recipient, currency)

  // Check amount before signature — cheaper than ecrecover.
  if (voucher.cumulativeAmount > onChain.deposit) {
    throw new Error('Voucher amount exceeds on-chain deposit')
  }

  const isValid = await verifyVoucher(
    methodDetails.escrowContract,
    methodDetails.chainId,
    voucher,
    onChain.authorizedSigner,
  )

  if (!isValid) {
    throw new Error('Invalid voucher signature')
  }

  // Note: validateOnChainChannel checked finalized above, but there's an inherent
  // TOCTOU window between the on-chain read and this storage write. A channel
  // finalized in that window would still be accepted here. This is acceptable
  // because the window is milliseconds and on-chain settlement is the source of
  // truth — a finalized channel simply can't be claimed twice on-chain.
  await storage.updateChannel(payload.channelId, (existing) => {
    if (existing) {
      if (voucher.cumulativeAmount > existing.highestVoucherAmount) {
        return {
          ...existing,
          deposit: onChain.deposit,
          highestVoucherAmount: voucher.cumulativeAmount,
          highestVoucher: voucher,
        }
      }
      return { ...existing, deposit: onChain.deposit }
    }
    return {
      channelId: payload.channelId,
      payer: onChain.payer,
      payee: onChain.payee,
      token: onChain.token,
      authorizedSigner: onChain.authorizedSigner,
      deposit: onChain.deposit,
      highestVoucherAmount: voucher.cumulativeAmount,
      highestVoucher: voucher,
      createdAt: new Date(),
    }
  })

  const session = await acceptVoucher(
    storage,
    challenge.id,
    payload.channelId,
    voucher.cumulativeAmount,
  )
  if (!session) throw new Error('Failed to create session')

  return createStreamReceipt({
    challengeId: challenge.id,
    channelId: payload.channelId,
    acceptedCumulative: voucher.cumulativeAmount,
    spent: session.spent,
    units: session.units,
  })
}

/**
 * Handle 'topUp' action - verify top-up and update channel state.
 */
async function handleTopUp(
  storage: ChannelStorage,
  rpcUrl: string,
  minVoucherDelta: bigint,
  challenge: Challenge.Challenge,
  payload: StreamCredentialPayload & { action: 'topUp' },
  methodDetails: { escrowContract: Address; chainId: number },
): Promise<StreamReceipt> {
  const channel = await storage.getChannel(payload.channelId)
  if (!channel) {
    throw new Error('Channel not found')
  }

  const { deposit: onChainDeposit } = await verifyTopUpTransaction(
    rpcUrl,
    methodDetails.escrowContract,
    payload.channelId,
    payload.topUpTxHash,
    channel.deposit,
  )

  const voucher = parseVoucherFromPayload(
    payload.channelId,
    payload.cumulativeAmount,
    payload.voucherSignature,
  )

  return verifyAndAcceptVoucher({
    storage,
    minVoucherDelta,
    challenge,
    channel,
    channelId: payload.channelId,
    voucher,
    onChainDeposit,
    methodDetails,
  })
}

/**
 * Handle 'voucher' action - verify and accept a new voucher.
 */
async function handleVoucher(
  storage: ChannelStorage,
  rpcUrl: string,
  minVoucherDelta: bigint,
  challenge: Challenge.Challenge,
  payload: StreamCredentialPayload & { action: 'voucher' },
  methodDetails: { escrowContract: Address; chainId: number },
): Promise<StreamReceipt> {
  const channel = await storage.getChannel(payload.channelId)
  if (!channel) {
    throw new Error('Channel not found')
  }

  const voucher = parseVoucherFromPayload(
    payload.channelId,
    payload.cumulativeAmount,
    payload.signature,
  )

  const onChain = await getOnChainChannel(rpcUrl, methodDetails.escrowContract, payload.channelId)

  return verifyAndAcceptVoucher({
    storage,
    minVoucherDelta,
    challenge,
    channel,
    channelId: payload.channelId,
    voucher,
    onChainDeposit: onChain.deposit,
    methodDetails,
  })
}

/**
 * Handle 'close' action - verify final voucher and close channel.
 */
async function handleClose(
  storage: ChannelStorage,
  rpcUrl: string,
  walletClient: WalletClient | undefined,
  challenge: Challenge.Challenge,
  payload: StreamCredentialPayload & { action: 'close' },
  methodDetails: { escrowContract: Address; chainId: number },
): Promise<StreamReceipt> {
  const channel = await storage.getChannel(payload.channelId)
  if (!channel) {
    throw new Error('Channel not found')
  }

  const voucher = parseVoucherFromPayload(
    payload.channelId,
    payload.cumulativeAmount,
    payload.voucherSignature,
  )

  if (voucher.cumulativeAmount < channel.highestVoucherAmount) {
    throw new Error('Close voucher amount must be >= highest accepted voucher')
  }

  // Re-read on-chain deposit to avoid rejecting valid closes after a top-up
  const onChain = await getOnChainChannel(rpcUrl, methodDetails.escrowContract, payload.channelId)
  if (voucher.cumulativeAmount > onChain.deposit) {
    throw new Error('Close voucher amount exceeds on-chain deposit')
  }

  const isValid = await verifyVoucher(
    methodDetails.escrowContract,
    methodDetails.chainId,
    voucher,
    channel.authorizedSigner,
  )

  if (!isValid) {
    throw new Error('Invalid voucher signature')
  }

  const session = await storage.getSession(challenge.id)

  // TODO: Submit on-chain close transaction if walletClient available
  let txHash: Hex | undefined
  if (walletClient) {
    // In production, submit the close transaction here
    // txHash = await submitCloseTransaction(walletClient, channel, voucher)
  }

  // Persist the final voucher for later on-chain settlement instead of deleting
  await storage.updateChannel(payload.channelId, (current) => {
    if (!current) return null
    return {
      ...current,
      deposit: onChain.deposit,
      highestVoucherAmount: voucher.cumulativeAmount,
      highestVoucher: voucher,
    }
  })
  await storage.updateSession(challenge.id, () => null)

  return createStreamReceipt({
    challengeId: challenge.id,
    channelId: payload.channelId,
    acceptedCumulative: voucher.cumulativeAmount,
    spent: session?.spent ?? 0n,
    units: session?.units ?? 0,
    ...(txHash !== undefined && { txHash }),
  })
}
