/**
 * Server-side session payment method for request/response flows.
 *
 * Handles the full channel lifecycle (open, voucher, top-up, close) and
 * one-shot settlement. Each incoming request carries a stream credential
 * with a cumulative voucher that the server validates and records.
 *
 * Use `session()` for standard HTTP request/response patterns where each
 * request is a discrete paid unit (for example, a page scrape or API call).
 * For long-lived connections that emit multiple paid events over a single
 * request, use {@link ../stream/Sse} instead.
 */
import {
  type Account as viem_Account,
  type Address,
  type Hex,
  parseUnits,
  type Client as viem_Client,
} from 'viem'
import { tempo as tempo_chain } from 'viem/chains'
import {
  AmountExceedsDepositError,
  BadRequestError,
  ChannelClosedError,
  ChannelNotFoundError,
  DeltaTooSmallError,
  InsufficientBalanceError,
  InvalidSignatureError,
  VerificationFailedError,
} from '../../Errors.js'
import type { Challenge, Credential } from '../../index.js'
import type { LooseOmit } from '../../internal/types.js'
import * as MethodIntent from '../../MethodIntent.js'
import * as Client from '../../viem/Client.js'
import * as Intents from '../Intents.js'
import * as defaults from '../internal/defaults.js'
import * as Account from '../internal/account.js'
import type * as types from '../internal/types.js'
import {
  broadcastOpenTransaction,
  broadcastTopUpTransaction,
  closeOnChain,
  getOnChainChannel,
  type OnChainChannel,
  settleOnChain,
} from '../stream/Chain.js'
import { createStreamReceipt } from '../stream/Receipt.js'
import * as Transport from './internal/transport.js'
import type { ChannelState, ChannelStorage, Storage } from '../stream/Storage.js'
import { channelStorage, deductFromChannel, memoryStorage } from '../stream/Storage.js'
import type { SignedVoucher, StreamCredentialPayload, StreamReceipt } from '../stream/Types.js'
import { parseVoucherFromPayload, verifyVoucher } from '../stream/Voucher.js'

/** Challenge methodDetails shape for stream intents. */
type StreamMethodDetails = {
  escrowContract: Address
  chainId: number
  channelId?: Hex | undefined
  minVoucherDelta?: string | undefined
  feePayer?: boolean | undefined
}

/**
 * Creates a stream payment server using the mpay Method.toServer() pattern.
 *
 * @example
 * ```ts
 * import { Mpay, tempo } from 'mpay/server'
 *
 * const mpay = Mpay.create({
 *   methods: [
 *     tempo.session({
 *       storage: myStorage,
 *       recipient: '0x...',
 *       currency: '0x...',
 *       escrowContract: '0x...',
 *     }),
 *   ],
 *   realm: 'my-app',
 *   secretKey: '...',
 * })
 * ```
 */
export function session<const parameters extends session.Parameters>(p?: parameters) {
  const parameters = p as parameters
  const {
    amount,
    currency,
    decimals = defaults.decimals,
    storage: rawStorage = memoryStorage(),
    suggestedDeposit,
    unitType,
  } = parameters

  const storage = channelStorage(rawStorage)

  const getClient = Client.getResolver({
    chain: tempo_chain,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })
  const { recipient, feePayer } = Account.resolve(parameters)

  type Transport = parameters['stream'] extends true ? Transport.Sse : undefined
  const transport = parameters.stream ? Transport.sse(storage) : undefined

  type Defaults = session.DeriveDefaults<parameters>
  return MethodIntent.toServer<typeof Intents.session, Defaults, Transport>(Intents.session, {
    defaults: {
      amount,
      currency,
      decimals,
      recipient,
      suggestedDeposit,
      unitType,
    } as unknown as Defaults,

    transport: transport as never,

    // TODO: dedupe `{charge,stream}.request`
    async request({ credential, request }) {
      // Extract chainId from request or default.
      const chainId = await (async () => {
        if (request.chainId) return request.chainId
        if (parameters.testnet) return defaults.testnetChainId
        return (await getClient({})).chain?.id
      })()

      // Validate chainId.
      const client = await (async () => {
        try {
          return await getClient({ chainId })
        } catch {
          throw new Error(`No client configured with chainId ${chainId}.`)
        }
      })()
      if (client.chain?.id !== chainId)
        throw new Error(`Client not configured with chainId ${chainId}.`)

      const escrowContract =
        request.escrowContract ??
        parameters.escrowContract ??
        defaults.escrowContract[chainId as keyof typeof defaults.escrowContract]

      // Extract feePayer.
      const resolvedFeePayer = (() => {
        const account = typeof request.feePayer === 'object' ? request.feePayer : feePayer
        const requested = request.feePayer !== false && (account ?? feePayer)
        if (credential) return account
        if (requested) return true
        return undefined
      })()

      return { ...request, chainId, escrowContract, feePayer: resolvedFeePayer }
    },

    async verify({ credential }) {
      const { challenge, payload } = credential as Credential.Credential<StreamCredentialPayload>

      const methodDetails = challenge.request.methodDetails as StreamMethodDetails
      const client = await getClient({ chainId: methodDetails.chainId })

      const resolvedFeePayer = methodDetails.feePayer === true ? feePayer : undefined
      const minVoucherDelta = parseUnits(parameters.minVoucherDelta ?? '0', decimals)
      const effectiveMinVoucherDelta = methodDetails.minVoucherDelta
        ? BigInt(methodDetails.minVoucherDelta)
        : minVoucherDelta

      let streamReceipt: StreamReceipt

      switch (payload.action) {
        case 'open':
          streamReceipt = await handleOpen(
            storage,
            client,
            challenge,
            payload,
            methodDetails,
            resolvedFeePayer,
          )
          break

        case 'topUp':
          streamReceipt = await handleTopUp(
            storage,
            client,
            challenge,
            payload,
            methodDetails,
            resolvedFeePayer,
          )
          break

        case 'voucher':
          streamReceipt = await handleVoucher(
            storage,
            client,
            effectiveMinVoucherDelta,
            challenge,
            payload,
            methodDetails,
          )
          break

        case 'close':
          streamReceipt = await handleClose(storage, client, challenge, payload, methodDetails)
          break

        default:
          throw new BadRequestError({
            reason: `unknown action: ${(payload as { action: string }).action}`,
          })
      }

      return streamReceipt
    },

    // This hook acts as a gate: when it returns a Response, `withReceipt()`
    // in Mpay.ts short-circuits and returns that response directly without
    // invoking the user's route handler. When it returns undefined, the
    // user's handler runs normally and serves content.
    //
    // We only gate on POST because POST signals an explicit management
    // request (SSE/manual mode) — e.g. a mid-stream voucher POST to
    // /api/chat should NOT start a new SSE stream. GET requests always
    // fall through so auto-mode clients (whose fetch wrapper bundles
    // open+voucher into a single GET retry) receive content as expected.
    respond({ credential, input }) {
      if (input.method !== 'POST') return undefined
      const { payload } = credential as Credential.Credential<StreamCredentialPayload>
      const isManagement =
        payload.action === 'open' || payload.action === 'topUp' || payload.action === 'close'
      const isVoucher = payload.action === 'voucher'
      if (!isManagement && !isVoucher) return undefined
      return new Response(null, { status: 204 })
    },
  })
}

export declare namespace session {
  type Defaults = LooseOmit<
    MethodIntent.RequestDefaults<typeof Intents.session>,
    'feePayer' | 'recipient'
  >

  type Parameters = {
    /** Minimum voucher delta to accept (numeric string, default: "0"). */
    minVoucherDelta?: string | undefined
    /** Storage backend for channel state. */
    storage?: Storage | undefined
    /** Enable SSE streaming. */
    stream?: boolean | undefined
    /** Testnet mode. */
    testnet?: boolean | undefined
  } & Account.resolve.Parameters &
    Client.getResolver.Parameters &
    Defaults

  type DeriveDefaults<parameters extends Parameters> = types.DeriveDefaults<
    parameters,
    Defaults
  > & {
    decimals: number
    escrowContract: Address
  }
}

/**
 * One-shot settle: reads highest voucher from storage and submits on-chain.
 */
export async function settle(
  storage: ChannelStorage,
  client: viem_Client,
  escrowContract: Address,
  channelId: Hex,
): Promise<Hex> {
  const channel = await storage.getChannel(channelId)
  if (!channel) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (!channel.highestVoucher) throw new VerificationFailedError({ reason: 'no voucher to settle' })

  const settledAmount = channel.highestVoucher.cumulativeAmount
  const txHash = await settleOnChain(client, escrowContract, channel.highestVoucher)

  await storage.updateChannel(channelId, (current) => {
    if (!current) return null
    const nextSettled =
      settledAmount > current.settledOnChain ? settledAmount : current.settledOnChain
    return { ...current, settledOnChain: nextSettled }
  })

  return txHash
}

/**
 * Charge against a channel's balance.
 *
 * Exported so consumers can deduct from a channel outside the `stream()`
 * handler (e.g., custom middleware, the SSE `serve()` loop, or direct tests).
 *
 * Delegates to the shared `deductFromChannel` atomic helper and translates
 * failure modes into typed errors (`InsufficientBalanceError`, `ChannelClosedError`).
 */
export async function charge(
  storage: ChannelStorage,
  channelId: Hex,
  amount: bigint,
): Promise<ChannelState> {
  let result: Awaited<ReturnType<typeof deductFromChannel>>
  try {
    result = await deductFromChannel(storage, channelId, amount)
  } catch {
    throw new ChannelClosedError({ reason: 'channel not found' })
  }
  if (!result.ok) {
    const available = result.channel.highestVoucherAmount - result.channel.spent
    throw new InsufficientBalanceError({
      reason: `requested ${amount}, available ${available}`,
    })
  }
  return result.channel
}

/**
 * Validate on-chain channel state.
 */
function validateOnChainChannel(
  onChain: OnChainChannel,
  recipient: Address,
  currency: Address,
  amount?: bigint,
): void {
  if (onChain.deposit === 0n) {
    throw new ChannelNotFoundError({ reason: 'channel not funded on-chain' })
  }
  if (onChain.finalized) {
    throw new ChannelClosedError({ reason: 'channel is finalized on-chain' })
  }
  if (onChain.closeRequestedAt !== 0n) {
    throw new ChannelClosedError({ reason: 'channel has a pending close request' })
  }
  if (onChain.payee.toLowerCase() !== recipient.toLowerCase()) {
    throw new VerificationFailedError({
      reason: 'on-chain payee does not match server destination',
    })
  }
  if (onChain.token.toLowerCase() !== currency.toLowerCase()) {
    throw new VerificationFailedError({ reason: 'on-chain token does not match server token' })
  }
  if (amount !== undefined && onChain.deposit - onChain.settled < amount) {
    throw new InsufficientBalanceError({
      reason: 'channel available balance insufficient for requested amount',
    })
  }
}

/**
 * Shared logic for verifying an incremental voucher and updating channel state.
 * Used by both handleVoucher and (indirectly) handleOpen.
 */
async function verifyAndAcceptVoucher(parameters: {
  storage: ChannelStorage
  minVoucherDelta: bigint
  challenge: Challenge.Challenge
  channel: ChannelState
  channelId: Hex
  voucher: SignedVoucher
  onChain: OnChainChannel
  methodDetails: StreamMethodDetails
}): Promise<StreamReceipt> {
  const {
    storage,
    minVoucherDelta,
    challenge,
    channel,
    channelId,
    voucher,
    onChain,
    methodDetails,
  } = parameters

  if (onChain.finalized) {
    throw new ChannelClosedError({ reason: 'channel is finalized on-chain' })
  }
  if (onChain.closeRequestedAt !== 0n) {
    throw new ChannelClosedError({ reason: 'channel has a pending close request' })
  }

  if (voucher.cumulativeAmount < onChain.settled) {
    throw new VerificationFailedError({
      reason: 'voucher cumulativeAmount is below on-chain settled amount',
    })
  }

  if (voucher.cumulativeAmount > onChain.deposit) {
    throw new AmountExceedsDepositError({ reason: 'voucher amount exceeds on-chain deposit' })
  }

  if (voucher.cumulativeAmount <= channel.highestVoucherAmount) {
    return createStreamReceipt({
      challengeId: challenge.id,
      channelId,
      acceptedCumulative: channel.highestVoucherAmount,
      spent: channel.spent,
      units: channel.units,
    })
  }

  const delta = voucher.cumulativeAmount - channel.highestVoucherAmount
  if (delta < minVoucherDelta) {
    throw new DeltaTooSmallError({
      reason: `voucher delta ${delta} below minimum ${minVoucherDelta}`,
    })
  }

  const isValid = await verifyVoucher(
    methodDetails.escrowContract,
    methodDetails.chainId,
    voucher,
    channel.authorizedSigner,
  )

  if (!isValid) {
    throw new InvalidSignatureError({ reason: 'invalid voucher signature' })
  }

  const updated = await storage.updateChannel(channelId, (current) => {
    if (!current) throw new ChannelNotFoundError({ reason: 'channel not found' })
    if (voucher.cumulativeAmount > current.highestVoucherAmount) {
      return {
        ...current,
        deposit: onChain.deposit,
        highestVoucherAmount: voucher.cumulativeAmount,
        highestVoucher: voucher,
      }
    }
    return current
  })
  if (!updated) throw new ChannelNotFoundError({ reason: 'channel not found' })

  return createStreamReceipt({
    challengeId: challenge.id,
    channelId,
    acceptedCumulative: updated.highestVoucherAmount,
    spent: updated.spent,
    units: updated.units,
  })
}

/**
 * Handle 'open' action - broadcast open transaction, verify voucher, and create channel.
 */
async function handleOpen(
  storage: ChannelStorage,
  client: viem_Client,
  challenge: Challenge.Challenge,
  payload: StreamCredentialPayload & { action: 'open' },
  methodDetails: StreamMethodDetails,
  feePayer: viem_Account | undefined,
): Promise<StreamReceipt> {
  const voucher = parseVoucherFromPayload(
    payload.channelId,
    payload.cumulativeAmount,
    payload.signature,
  )

  const recipient = challenge.request.recipient as Address
  const currency = challenge.request.currency as Address
  const amount = challenge.request.amount ? BigInt(challenge.request.amount as string) : undefined

  const { onChain, txHash } = await broadcastOpenTransaction({
    client,
    serializedTransaction: payload.transaction,
    escrowContract: methodDetails.escrowContract,
    channelId: payload.channelId,
    recipient,
    currency,
    feePayer,
  })

  validateOnChainChannel(onChain, recipient, currency, amount)

  const authorizedSigner =
    onChain.authorizedSigner === '0x0000000000000000000000000000000000000000'
      ? onChain.payer
      : onChain.authorizedSigner

  if (voucher.cumulativeAmount > onChain.deposit) {
    throw new AmountExceedsDepositError({ reason: 'voucher amount exceeds on-chain deposit' })
  }

  if (voucher.cumulativeAmount < onChain.settled) {
    throw new VerificationFailedError({
      reason: 'voucher cumulativeAmount is below on-chain settled amount',
    })
  }

  const isValid = await verifyVoucher(
    methodDetails.escrowContract,
    methodDetails.chainId,
    voucher,
    authorizedSigner,
  )

  if (!isValid) {
    throw new InvalidSignatureError({ reason: 'invalid voucher signature' })
  }

  const updated = await storage.updateChannel(payload.channelId, (existing) => {
    if (existing) {
      if (voucher.cumulativeAmount < existing.settledOnChain) {
        throw new VerificationFailedError({
          reason: 'voucher amount is below settled on-chain amount',
        })
      }

      if (voucher.cumulativeAmount > existing.highestVoucherAmount) {
        return {
          ...existing,
          deposit: onChain.deposit,
          highestVoucherAmount: voucher.cumulativeAmount,
          highestVoucher: voucher,
          authorizedSigner,
        }
      }
      return {
        ...existing,
        deposit: onChain.deposit,
        authorizedSigner,
      }
    }
    return {
      channelId: payload.channelId,
      payer: onChain.payer,
      payee: onChain.payee,
      token: onChain.token,
      authorizedSigner,
      deposit: onChain.deposit,
      settledOnChain: 0n,
      highestVoucherAmount: voucher.cumulativeAmount,
      highestVoucher: voucher,
      spent: 0n,
      units: 0,
      finalized: false,
      createdAt: new Date(),
    }
  })

  if (!updated) throw new VerificationFailedError({ reason: 'failed to create channel' })

  return createStreamReceipt({
    challengeId: challenge.id,
    channelId: payload.channelId,
    acceptedCumulative: updated.highestVoucherAmount,
    spent: updated.spent,
    units: updated.units,
    txHash,
  })
}

/**
 * Handle 'topUp' action - broadcast topUp transaction and update channel deposit.
 *
 * Per spec Section 8.3.2, topUp payloads contain only the transaction and
 * additionalDeposit — no voucher. The client must send a separate 'voucher'
 * action to authorize spending the new funds.
 */
async function handleTopUp(
  storage: ChannelStorage,
  client: viem_Client,
  challenge: Challenge.Challenge,
  payload: StreamCredentialPayload & { action: 'topUp' },
  methodDetails: StreamMethodDetails,
  feePayer: viem_Account | undefined,
): Promise<StreamReceipt> {
  const channel = await storage.getChannel(payload.channelId)
  if (!channel) {
    throw new ChannelNotFoundError({ reason: 'channel not found' })
  }

  const declaredDeposit = BigInt(payload.additionalDeposit)

  const { newDeposit: onChainDeposit } = await broadcastTopUpTransaction({
    client,
    serializedTransaction: payload.transaction,
    escrowContract: methodDetails.escrowContract,
    channelId: payload.channelId,
    declaredDeposit,
    previousDeposit: channel.deposit,
    feePayer,
  })

  const updated = await storage.updateChannel(payload.channelId, (current) => {
    if (!current) throw new ChannelNotFoundError({ reason: 'channel not found' })
    return { ...current, deposit: onChainDeposit }
  })

  return createStreamReceipt({
    challengeId: challenge.id,
    channelId: payload.channelId,
    acceptedCumulative: updated?.highestVoucherAmount ?? channel.highestVoucherAmount,
    spent: updated?.spent ?? channel.spent,
    units: updated?.units ?? channel.units,
  })
}

/**
 * Handle 'voucher' action - verify and accept a new voucher.
 */
async function handleVoucher(
  storage: ChannelStorage,
  client: viem_Client,
  minVoucherDelta: bigint,
  challenge: Challenge.Challenge,
  payload: StreamCredentialPayload & { action: 'voucher' },
  methodDetails: StreamMethodDetails,
): Promise<StreamReceipt> {
  const channel = await storage.getChannel(payload.channelId)
  if (!channel) {
    throw new ChannelNotFoundError({ reason: 'channel not found' })
  }
  if (channel.finalized) {
    throw new ChannelClosedError({ reason: 'channel is finalized' })
  }

  const voucher = parseVoucherFromPayload(
    payload.channelId,
    payload.cumulativeAmount,
    payload.signature,
  )

  const onChain = await getOnChainChannel(client, methodDetails.escrowContract, payload.channelId)

  return verifyAndAcceptVoucher({
    storage,
    minVoucherDelta,
    challenge,
    channel,
    channelId: payload.channelId,
    voucher,
    onChain,
    methodDetails,
  })
}

/**
 * Handle 'close' action - verify final voucher and close channel.
 */
async function handleClose(
  storage: ChannelStorage,
  client: viem_Client,
  challenge: Challenge.Challenge,
  payload: StreamCredentialPayload & { action: 'close' },
  methodDetails: StreamMethodDetails,
): Promise<StreamReceipt> {
  const channel = await storage.getChannel(payload.channelId)
  if (!channel) {
    throw new ChannelNotFoundError({ reason: 'channel not found' })
  }
  if (channel.finalized) {
    throw new ChannelClosedError({ reason: 'channel is already finalized' })
  }

  const voucher = parseVoucherFromPayload(
    payload.channelId,
    payload.cumulativeAmount,
    payload.signature,
  )

  if (voucher.cumulativeAmount < channel.highestVoucherAmount) {
    throw new VerificationFailedError({
      reason: 'close voucher amount must be >= highest accepted voucher',
    })
  }

  const onChain = await getOnChainChannel(client, methodDetails.escrowContract, payload.channelId)

  if (onChain.finalized) {
    throw new ChannelClosedError({ reason: 'channel is finalized on-chain' })
  }

  if (voucher.cumulativeAmount < onChain.settled) {
    throw new VerificationFailedError({
      reason: 'close voucher cumulativeAmount is below on-chain settled amount',
    })
  }

  if (voucher.cumulativeAmount > onChain.deposit) {
    throw new AmountExceedsDepositError({
      reason: 'close voucher amount exceeds on-chain deposit',
    })
  }

  const isValid = await verifyVoucher(
    methodDetails.escrowContract,
    methodDetails.chainId,
    voucher,
    channel.authorizedSigner,
  )

  if (!isValid) {
    throw new InvalidSignatureError({ reason: 'invalid voucher signature' })
  }

  if (!client.account) {
    throw new Error(
      'Cannot close channel: client has no account. Provide a `getClient` that returns an account-bearing client.',
    )
  }

  const txHash = await closeOnChain(client, methodDetails.escrowContract, voucher)

  const updated = await storage.updateChannel(payload.channelId, (current) => {
    if (!current) return null
    return {
      ...current,
      deposit: onChain.deposit,
      highestVoucherAmount: voucher.cumulativeAmount,
      highestVoucher: voucher,
      finalized: true,
    }
  })

  return createStreamReceipt({
    challengeId: challenge.id,
    channelId: payload.channelId,
    acceptedCumulative: voucher.cumulativeAmount,
    spent: updated?.spent ?? channel.spent,
    units: updated?.units ?? channel.units,
    ...(txHash !== undefined && { txHash }),
  })
}
