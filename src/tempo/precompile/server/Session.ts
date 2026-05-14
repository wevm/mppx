import {
  type Address,
  type Hex,
  isAddressEqual,
  parseEventLogs,
  parseUnits,
  zeroAddress,
  type Account as viem_Account,
} from 'viem'
import {
  call,
  sendRawTransaction,
  sendRawTransactionSync,
  signTransaction,
  waitForTransactionReceipt,
} from 'viem/actions'
import { tempo as tempo_chain } from 'viem/chains'
import { Transaction } from 'viem/tempo'

import {
  AmountExceedsDepositError,
  ChannelClosedError,
  ChannelNotFoundError,
  DeltaTooSmallError,
  InsufficientBalanceError,
  InvalidSignatureError,
  VerificationFailedError,
  BadRequestError,
} from '../../../Errors.js'
import type { Challenge, Credential } from '../../../index.js'
import type { LooseOmit, NoExtraKeys } from '../../../internal/types.js'
import * as Method from '../../../Method.js'
import * as Store from '../../../Store.js'
import * as Client from '../../../viem/Client.js'
import * as defaults from '../../internal/defaults.js'
import * as FeePayer from '../../internal/fee-payer.js'
import type * as types from '../../internal/types.js'
import * as Methods from '../../Methods.js'
import {
  captureRequestBodyProbe,
  isSessionContentRequest,
} from '../../server/internal/request-body.js'
import * as ChannelStore from '../../session/ChannelStore.js'
import { createSessionReceipt } from '../../session/Receipt.js'
import type { SessionReceipt } from '../../session/Types.js'
import * as Chain from '../Chain.js'
import * as Channel from '../Channel.js'
import { tip20ChannelEscrow } from '../Constants.js'
import { escrowAbi } from '../escrow.abi.js'
import {
  parseCredentialPayload,
  type ParsedSessionCredentialPayload,
  type SessionCredentialPayload,
  uint96,
} from '../Types.js'
import * as Voucher from '../Voucher.js'
import * as ChannelOps from './ChannelOps.js'

type SessionMethodDetails = {
  chainId: number
  escrowContract?: Address | undefined
  channelId?: Hex | undefined
  feePayer?: boolean | undefined
  minVoucherDelta?: string | undefined
}

function authorizedSigner(descriptor: Channel.ChannelDescriptor): Address {
  return isAddressEqual(descriptor.authorizedSigner, zeroAddress)
    ? descriptor.payer
    : descriptor.authorizedSigner
}

function assertSameDescriptor(a: Channel.ChannelDescriptor, b: Channel.ChannelDescriptor) {
  if (
    !isAddressEqual(a.payer, b.payer) ||
    !isAddressEqual(a.payee, b.payee) ||
    !isAddressEqual(a.operator, b.operator) ||
    !isAddressEqual(a.token, b.token) ||
    !isAddressEqual(a.authorizedSigner, b.authorizedSigner) ||
    a.salt.toLowerCase() !== b.salt.toLowerCase() ||
    a.expiringNonceHash.toLowerCase() !== b.expiringNonceHash.toLowerCase()
  )
    throw new VerificationFailedError({
      reason: 'credential descriptor does not match stored channel',
    })
}

function validateDescriptor(parameters: {
  descriptor: Channel.ChannelDescriptor
  channelId: Hex
  chainId: number
  escrow: Address
  recipient: Address
  currency: Address
}) {
  const { descriptor, channelId, chainId, escrow, recipient, currency } = parameters
  const computed = Channel.computeId({ ...descriptor, chainId, escrow })
  if (computed.toLowerCase() !== channelId.toLowerCase())
    throw new VerificationFailedError({ reason: 'credential channelId does not match descriptor' })
  if (!isAddressEqual(descriptor.payee, recipient))
    throw new VerificationFailedError({ reason: 'descriptor payee does not match challenge' })
  if (!isAddressEqual(descriptor.token, currency))
    throw new VerificationFailedError({ reason: 'descriptor token does not match challenge' })
}

async function sendTransaction(client: Parameters<typeof sendRawTransaction>[0], transaction: Hex) {
  return sendRawTransaction(client, { serializedTransaction: transaction })
}

async function waitForSuccessfulReceipt(
  client: Parameters<typeof sendRawTransaction>[0],
  hash: Hex,
) {
  const receipt = await waitForTransactionReceipt(client, { hash })
  if (receipt.status !== 'success')
    throw new VerificationFailedError({ reason: 'precompile transaction reverted' })
  return receipt
}

type ChannelReceiptEvent = {
  args: {
    channelId: Hex
    expiringNonceHash?: Hex | undefined
    deposit?: bigint | undefined
    newDeposit?: bigint | undefined
    newSettled?: bigint | undefined
    settledToPayee?: bigint | undefined
    refundedToPayer?: bigint | undefined
  }
}

function assertSenderSigned(transaction: ReturnType<(typeof Transaction)['deserialize']>): void {
  if (!transaction.signature || !transaction.from)
    throw new BadRequestError({
      reason: 'Transaction must be signed by the sender before fee payer co-signing',
    })
}

function assertDescriptor(payload: {
  descriptor?: Channel.ChannelDescriptor | undefined
}): asserts payload is { descriptor: Channel.ChannelDescriptor } {
  if (!payload.descriptor)
    throw new VerificationFailedError({
      reason: 'descriptor required for precompile session action',
    })
}

function assertSettlementSender(parameters: {
  operation: 'close' | 'settle'
  channelId: Hex
  operator: Address
  payee: Address
  sender: Address | undefined
}) {
  const { operation, channelId, operator, payee, sender } = parameters
  if (!sender)
    throw new Error(
      `Cannot ${operation} precompile channel ${channelId}: no account available. Pass an account override, or provide a getClient() that returns an account-bearing client.`,
    )
  if (isAddressEqual(sender, payee)) return
  if (!isAddressEqual(operator, zeroAddress) && isAddressEqual(sender, operator)) return
  throw new BadRequestError({
    reason:
      `Cannot ${operation} precompile channel ${channelId}: tx sender ${sender} is not the channel payee ${payee}` +
      (isAddressEqual(operator, zeroAddress) ? '.' : ` or operator ${operator}.`) +
      ' If using an access key, pass a Tempo access-key account whose address is the payee/operator wallet, not the raw delegated key address.',
  })
}

function getClientAccount(client: { account?: viem_Account | undefined }) {
  return client.account
}

function getChannelEvent(
  receipt: { logs: Parameters<typeof parseEventLogs>[0]['logs'] },
  name: 'ChannelOpened' | 'TopUp' | 'Settled' | 'ChannelClosed',
  channelId: Hex,
): ChannelReceiptEvent {
  const logs = parseEventLogs({
    abi: escrowAbi,
    eventName: name,
    logs: receipt.logs,
  }) as ChannelReceiptEvent[]
  const matches = logs.filter((log) => log.args.channelId.toLowerCase() === channelId.toLowerCase())
  if (matches.length !== 1)
    throw new VerificationFailedError({
      reason: `expected one ${name} event for credential channelId in receipt`,
    })
  return matches[0]!
}

/** Broadcasts a client-signed management transaction, adding a fee-payer co-signature when requested. */
async function sendCredentialTransaction(parameters: {
  challengeExpires?: string | undefined
  chainId: number
  client: Parameters<typeof sendRawTransaction>[0]
  details: Record<string, string>
  expectedFeeToken?: Address | undefined
  feePayer?: viem_Account | undefined
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
  label: 'open' | 'topUp'
  serializedTransaction: Hex
  transaction: ReturnType<(typeof Transaction)['deserialize']>
}) {
  const {
    challengeExpires,
    chainId,
    client,
    details,
    expectedFeeToken,
    feePayer,
    feePayerPolicy,
    label,
    serializedTransaction,
    transaction,
  } = parameters

  if (!feePayer) {
    const txHash = await sendTransaction(client, serializedTransaction)
    return waitForSuccessfulReceipt(client, txHash)
  }

  if (!FeePayer.isTempoTransaction(serializedTransaction))
    throw new BadRequestError({
      reason: 'Only Tempo (0x76/0x78) transactions are supported',
    })
  assertSenderSigned(transaction)

  await call(client, {
    ...transaction,
    account: transaction.from,
    calls: transaction.calls ?? [],
    feePayerSignature: undefined,
  } as never)

  const sponsored = FeePayer.prepareSponsoredTransaction({
    account: feePayer,
    challengeExpires,
    chainId,
    details,
    expectedFeeToken,
    policy: feePayerPolicy,
    transaction: {
      ...transaction,
      ...(expectedFeeToken ? { feeToken: transaction.feeToken ?? expectedFeeToken } : {}),
    },
  })
  const serialized = (await signTransaction(client, sponsored as never)) as Hex
  const receipt = await sendRawTransactionSync(client, {
    serializedTransaction: serialized as Transaction.TransactionSerializedTempo,
  })
  if (receipt.status !== 'success')
    throw new VerificationFailedError({
      reason: `${label} precompile transaction reverted: ${receipt.transactionHash}`,
    })
  return receipt
}

/** Creates a server-side TIP-1034 precompile session payment method. */
export function session<const parameters extends session.Parameters>(
  p?: NoExtraKeys<parameters, session.Parameters>,
) {
  const parameters = p as parameters
  const {
    amount,
    channelStateTtl = 5_000,
    currency = defaults.resolveCurrency(parameters),
    decimals = defaults.decimals,
    store: rawStore = Store.memory(),
    suggestedDeposit,
    unitType,
  } = parameters

  const store = ChannelStore.fromStore(rawStore as never)
  const lastOnChainVerified = new Map<Hex, number>()
  const recipient = parameters.recipient as Address
  const getClient = Client.getResolver({
    chain: tempo_chain,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })

  type Defaults = session.DeriveDefaults<parameters>
  return Method.toServer<typeof Methods.session, Defaults>(Methods.session, {
    defaults: {
      amount,
      currency,
      decimals,
      recipient,
      suggestedDeposit,
      unitType,
    } as unknown as Defaults,

    async request({ credential, request }) {
      const chainId = request.chainId ?? parameters.chainId ?? (await getClient({})).chain?.id
      if (!chainId) throw new Error('No chainId configured for tempo.precompile.session().')
      const client = await getClient({ chainId })
      if (client.chain?.id !== chainId)
        throw new Error(`Client not configured with chainId ${chainId}.`)
      const resolvedFeePayer = (() => {
        if (request.feePayer === false) return credential ? false : undefined
        const account =
          typeof request.feePayer === 'object' ? request.feePayer : parameters.feePayer
        if (credential) return account ?? undefined
        if (account) return true
        return undefined
      })()
      return {
        ...request,
        chainId,
        escrowContract: request.escrowContract ?? parameters.escrow ?? tip20ChannelEscrow,
        feePayer: resolvedFeePayer,
      }
    },

    async verify({ credential, envelope, request }) {
      const { challenge, payload: rawPayload } = credential
      const payload = parseCredentialPayload(rawPayload as SessionCredentialPayload)
      const methodDetails = (request as typeof request & { methodDetails?: SessionMethodDetails })
        .methodDetails
      if (!methodDetails) throw new VerificationFailedError({ reason: 'missing methodDetails' })
      const chainId = methodDetails.chainId
      const escrow = methodDetails.escrowContract ?? parameters.escrow ?? tip20ChannelEscrow
      const client = await getClient({ chainId })
      const requestAllowsFeePayer =
        request.feePayer !== false &&
        (request.feePayer === undefined ||
          request.feePayer === true ||
          typeof request.feePayer === 'object')
      const resolvedFeePayer =
        methodDetails.feePayer === true && requestAllowsFeePayer
          ? typeof request.feePayer === 'object'
            ? request.feePayer
            : parameters.feePayer
          : undefined
      const minVoucherDelta = methodDetails.minVoucherDelta
        ? BigInt(methodDetails.minVoucherDelta)
        : parseUnits(parameters.minVoucherDelta ?? '0', decimals)

      let sessionReceipt: SessionReceipt

      switch (payload.action) {
        case 'open': {
          sessionReceipt = await handleOpen({
            store,
            client,
            challenge,
            payload,
            chainId,
            escrow,
            feePayer: resolvedFeePayer,
            feePayerPolicy: parameters.feePayerPolicy,
          })
          lastOnChainVerified.set(sessionReceipt.channelId as Hex, Date.now())
          break
        }
        case 'topUp': {
          sessionReceipt = await handleTopUp({
            store,
            client,
            challenge,
            payload,
            chainId,
            escrow,
            feePayer: resolvedFeePayer,
            feePayerPolicy: parameters.feePayerPolicy,
          })
          lastOnChainVerified.set(sessionReceipt.channelId as Hex, Date.now())
          break
        }
        case 'voucher': {
          sessionReceipt = await handleVoucher({
            store,
            client,
            challenge,
            payload,
            chainId,
            escrow,
            channelStateTtl,
            lastOnChainVerified,
            minVoucherDelta,
          })
          break
        }
        case 'close': {
          sessionReceipt = await handleClose({
            store,
            client,
            challenge,
            payload,
            chainId,
            escrow,
            account: parameters.account,
            feePayer: resolvedFeePayer,
            feePayerPolicy: parameters.feePayerPolicy,
            feeToken: parameters.feeToken,
          })
          break
        }
        default:
          throw new VerificationFailedError({ reason: 'unsupported precompile session action' })
      }

      if (
        envelope &&
        isSessionContentRequest(envelope.capturedRequest) &&
        (payload.action === 'open' || payload.action === 'voucher')
      ) {
        const charged = await charge(
          store,
          sessionReceipt.channelId as Hex,
          BigInt((request as { amount?: string }).amount ?? challenge.request.amount),
        )
        sessionReceipt = {
          ...sessionReceipt,
          spent: charged.spent.toString(),
          units: charged.units,
        }
      }

      return sessionReceipt
    },

    respond({ credential, envelope, input }) {
      const { payload } = credential as Credential.Credential<SessionCredentialPayload>

      if (payload.action === 'close') return new Response(null, { status: 204 })
      if (payload.action === 'topUp') return new Response(null, { status: 204 })

      const request = envelope?.capturedRequest ?? captureRequestBodyProbe(input)
      if (isSessionContentRequest(request)) return undefined
      return new Response(null, { status: 204 })
    },
  })
}

/** Charges a fulfilled request against a precompile-backed session channel. */
export async function charge(
  store: ChannelStore.ChannelStore,
  channelId: Hex,
  amount: bigint,
): Promise<ChannelStore.State> {
  let result: Awaited<ReturnType<typeof ChannelStore.deductFromChannel>>
  try {
    result = await ChannelStore.deductFromChannel(store, channelId, amount)
  } catch {
    throw new ChannelClosedError({ reason: 'channel not found' })
  }
  if (!result.ok) {
    if (result.channel.finalized) throw new ChannelClosedError({ reason: 'channel is finalized' })
    if (result.channel.closeRequestedAt !== 0n)
      throw new ChannelClosedError({ reason: 'channel has a pending close request' })
    const available = result.channel.highestVoucherAmount - result.channel.spent
    throw new InsufficientBalanceError({
      reason: `requested ${amount}, available ${available}`,
    })
  }
  return result.channel
}

async function handleOpen(parameters: {
  store: ChannelStore.ChannelStore
  client: Parameters<typeof sendRawTransaction>[0]
  challenge: Challenge.Challenge
  payload: ParsedSessionCredentialPayload & { action: 'open' }
  chainId: number
  escrow: Address
  feePayer?: viem_Account | undefined
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
}): Promise<SessionReceipt> {
  const { store, client, challenge, payload, chainId, escrow } = parameters
  assertDescriptor(payload)
  if (
    payload.authorizedSigner !== undefined &&
    !isAddressEqual(payload.authorizedSigner, payload.descriptor.authorizedSigner)
  )
    throw new VerificationFailedError({
      reason: 'credential authorizedSigner does not match descriptor',
    })
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  validateDescriptor({
    descriptor: payload.descriptor,
    channelId,
    chainId,
    escrow,
    recipient: challenge.request.recipient as Address,
    currency: challenge.request.currency as Address,
  })

  const transaction = Transaction.deserialize(
    payload.transaction as Transaction.TransactionSerializedTempo,
  )
  const calls = transaction.calls
  if (calls.length !== 1)
    throw new VerificationFailedError({
      reason: 'TIP-1034 open transaction must contain exactly one call',
    })
  const call = calls[0]!
  if (!call.to || !isAddressEqual(call.to, escrow))
    throw new VerificationFailedError({
      reason: 'TIP-1034 open transaction targets the wrong address',
    })
  const payer = transaction.from ?? payload.descriptor.payer
  const open = ChannelOps.parseOpenCall({
    data: call.data!,
    expected: {
      payee: challenge.request.recipient as Address,
      token: challenge.request.currency as Address,
      operator: payload.descriptor.operator,
      authorizedSigner: payload.descriptor.authorizedSigner,
    },
  })
  const descriptor = ChannelOps.descriptorFromOpen({
    chainId,
    escrow,
    payer,
    open,
    expiringNonceHash: payload.descriptor.expiringNonceHash,
    channelId,
  })
  assertSameDescriptor(descriptor, payload.descriptor)
  const expiringNonceHash = Channel.computeExpiringNonceHash(
    transaction as Channel.ExpiringNonceTransaction,
    { sender: payer },
  )
  if (expiringNonceHash.toLowerCase() !== descriptor.expiringNonceHash.toLowerCase())
    throw new VerificationFailedError({
      reason: 'credential expiringNonceHash does not match transaction',
    })
  if (payload.cumulativeAmount > open.deposit)
    throw new AmountExceedsDepositError({ reason: 'voucher amount exceeds open deposit' })
  const valid = await Voucher.verifyVoucher(
    escrow,
    chainId,
    { channelId, cumulativeAmount: payload.cumulativeAmount, signature: payload.signature },
    authorizedSigner(descriptor),
  )
  if (!valid) throw new InvalidSignatureError({ reason: 'invalid voucher signature' })
  const receipt = await sendCredentialTransaction({
    challengeExpires: challenge.expires,
    chainId,
    client,
    details: {
      channelId,
      currency: challenge.request.currency as Address,
      recipient: challenge.request.recipient as Address,
    },
    expectedFeeToken: challenge.request.currency as Address,
    feePayer: parameters.feePayer,
    feePayerPolicy: parameters.feePayerPolicy,
    label: 'open',
    serializedTransaction: payload.transaction,
    transaction,
  })
  const txHash = receipt.transactionHash
  const opened = getChannelEvent(receipt, 'ChannelOpened', channelId)
  const emittedChannelId = opened.args.channelId as Hex
  const emittedExpiringNonceHash = opened.args.expiringNonceHash as Hex
  const emittedDeposit = uint96(opened.args.deposit as bigint)
  if (emittedChannelId.toLowerCase() !== channelId.toLowerCase())
    throw new VerificationFailedError({
      reason: 'ChannelOpened channelId does not match credential',
    })
  if (emittedExpiringNonceHash.toLowerCase() !== descriptor.expiringNonceHash.toLowerCase())
    throw new VerificationFailedError({
      reason: 'ChannelOpened expiringNonceHash does not match descriptor',
    })
  if (emittedDeposit !== open.deposit)
    throw new VerificationFailedError({ reason: 'ChannelOpened deposit does not match calldata' })
  const confirmedChannelId = Channel.computeId({ ...descriptor, chainId, escrow })
  if (confirmedChannelId.toLowerCase() !== emittedChannelId.toLowerCase())
    throw new VerificationFailedError({
      reason: 'descriptor does not match ChannelOpened channelId',
    })
  const chainChannel = await Chain.getChannel(client, descriptor, escrow)
  assertSameDescriptor(chainChannel.descriptor, descriptor)
  const state = chainChannel.state
  if (state.deposit !== emittedDeposit || state.settled !== 0n || state.closeRequestedAt !== 0)
    throw new VerificationFailedError({
      reason: 'on-chain channel state does not match open receipt',
    })

  const updated = await store.updateChannel(emittedChannelId, (current) => ({
    ...(current ?? {}),
    backend: 'precompile',
    channelId: emittedChannelId,
    chainId,
    escrowContract: escrow,
    closeRequestedAt:
      current && current.closeRequestedAt > BigInt(state.closeRequestedAt)
        ? current.closeRequestedAt
        : BigInt(state.closeRequestedAt),
    payer: descriptor.payer,
    payee: descriptor.payee,
    token: descriptor.token,
    authorizedSigner: authorizedSigner(descriptor),
    deposit: state.deposit,
    settledOnChain:
      current && current.settledOnChain > state.settled ? current.settledOnChain : state.settled,
    highestVoucherAmount:
      current?.highestVoucherAmount && current.highestVoucherAmount > payload.cumulativeAmount
        ? current.highestVoucherAmount
        : payload.cumulativeAmount,
    highestVoucher:
      current?.highestVoucherAmount && current.highestVoucherAmount > payload.cumulativeAmount
        ? current.highestVoucher
        : {
            channelId: emittedChannelId,
            cumulativeAmount: payload.cumulativeAmount,
            signature: payload.signature,
          },
    spent: current && current.spent > state.settled ? current.spent : state.settled,
    units: current?.units ?? 0,
    finalized: current?.finalized ?? false,
    createdAt: current?.createdAt ?? new Date().toISOString(),
    descriptor,
    operator: descriptor.operator,
    salt: descriptor.salt,
    expiringNonceHash: emittedExpiringNonceHash,
  }))
  if (!updated) throw new VerificationFailedError({ reason: 'failed to create channel' })
  return createSessionReceipt({
    challengeId: challenge.id,
    channelId,
    acceptedCumulative: updated.highestVoucherAmount,
    spent: updated.spent,
    units: updated.units,
    txHash,
  })
}

async function handleTopUp(parameters: {
  store: ChannelStore.ChannelStore
  client: Parameters<typeof sendRawTransaction>[0]
  challenge: Challenge.Challenge
  payload: ParsedSessionCredentialPayload & { action: 'topUp' }
  chainId: number
  escrow: Address
  feePayer?: viem_Account | undefined
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
}): Promise<SessionReceipt> {
  const { store, client, challenge, payload, chainId, escrow } = parameters
  assertDescriptor(payload)
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  const channel = await store.getChannel(channelId)
  if (!channel) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (!ChannelStore.isPrecompileState(channel))
    throw new VerificationFailedError({ reason: 'channel is not precompile-backed' })
  assertSameDescriptor(payload.descriptor, channel.descriptor)
  validateDescriptor({
    descriptor: payload.descriptor,
    channelId,
    chainId,
    escrow,
    recipient: channel.payee,
    currency: channel.token,
  })
  const transaction = Transaction.deserialize(
    payload.transaction as Transaction.TransactionSerializedTempo,
  )
  const calls = transaction.calls
  if (calls.length !== 1)
    throw new VerificationFailedError({
      reason: 'TIP-1034 topUp transaction must contain exactly one call',
    })
  const call = calls[0]!
  if (!call.to || !isAddressEqual(call.to, escrow))
    throw new VerificationFailedError({
      reason: 'TIP-1034 topUp transaction targets the wrong address',
    })
  ChannelOps.parseTopUpCall({
    data: call.data!,
    expected: { descriptor: channel.descriptor, additionalDeposit: payload.additionalDeposit },
  })
  const receipt = await sendCredentialTransaction({
    challengeExpires: challenge.expires,
    chainId,
    client,
    details: {
      additionalDeposit: payload.additionalDeposit.toString(),
      channelId,
      currency: channel.token,
    },
    expectedFeeToken: channel.token,
    feePayer: parameters.feePayer,
    feePayerPolicy: parameters.feePayerPolicy,
    label: 'topUp',
    serializedTransaction: payload.transaction,
    transaction,
  })
  const txHash = receipt.transactionHash
  const toppedUp = getChannelEvent(receipt, 'TopUp', channelId)
  const emittedChannelId = toppedUp.args.channelId as Hex
  const newDeposit = uint96(toppedUp.args.newDeposit as bigint)
  if (emittedChannelId.toLowerCase() !== channelId.toLowerCase())
    throw new VerificationFailedError({ reason: 'TopUp channelId does not match credential' })
  const state = await Chain.getChannelState(client, emittedChannelId, escrow)
  if (state.deposit !== newDeposit)
    throw new VerificationFailedError({
      reason: 'on-chain channel state does not match topUp receipt',
    })
  const updated = await store.updateChannel(emittedChannelId, (current) =>
    current
      ? {
          ...current,
          deposit: newDeposit > current.deposit ? newDeposit : current.deposit,
          settledOnChain:
            state.settled > current.settledOnChain ? state.settled : current.settledOnChain,
          closeRequestedAt:
            BigInt(state.closeRequestedAt) > current.closeRequestedAt
              ? BigInt(state.closeRequestedAt)
              : current.closeRequestedAt,
        }
      : current,
  )
  return createSessionReceipt({
    challengeId: challenge.id,
    channelId,
    acceptedCumulative: updated?.highestVoucherAmount ?? channel.highestVoucherAmount,
    spent: updated?.spent ?? channel.spent,
    units: updated?.units ?? channel.units,
    txHash,
  })
}

async function handleVoucher(parameters: {
  store: ChannelStore.ChannelStore
  client: Parameters<typeof sendRawTransaction>[0]
  challenge: Challenge.Challenge
  payload: ParsedSessionCredentialPayload & { action: 'voucher' }
  chainId: number
  escrow: Address
  minVoucherDelta: bigint
  channelStateTtl: number
  lastOnChainVerified: Map<Hex, number>
}): Promise<SessionReceipt> {
  const {
    store,
    client,
    challenge,
    payload,
    chainId,
    escrow,
    minVoucherDelta,
    channelStateTtl,
    lastOnChainVerified,
  } = parameters
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  assertDescriptor(payload)
  const channel = await store.getChannel(channelId)
  if (!channel) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (channel.finalized) throw new ChannelClosedError({ reason: 'channel is finalized' })
  if (!ChannelStore.isPrecompileState(channel))
    throw new VerificationFailedError({ reason: 'channel is not precompile-backed' })
  assertSameDescriptor(payload.descriptor, channel.descriptor)
  validateDescriptor({
    descriptor: payload.descriptor,
    channelId,
    chainId,
    escrow,
    recipient: channel.payee,
    currency: channel.token,
  })
  const stale = Date.now() - (lastOnChainVerified.get(channelId) ?? 0) > channelStateTtl
  const state = stale ? await Chain.getChannelState(client, channelId, escrow) : undefined
  if (state) lastOnChainVerified.set(channelId, Date.now())
  const deposit = state?.deposit ?? uint96(channel.deposit)
  const settled = state?.settled ?? uint96(channel.settledOnChain)
  const closeRequestedAt = state?.closeRequestedAt ?? Number(channel.closeRequestedAt)
  if (closeRequestedAt !== 0) {
    await store.updateChannel(channelId, (current) =>
      current
        ? {
            ...current,
            closeRequestedAt:
              BigInt(closeRequestedAt) > current.closeRequestedAt
                ? BigInt(closeRequestedAt)
                : current.closeRequestedAt,
          }
        : current,
    )
    throw new ChannelClosedError({ reason: 'channel has a pending close request' })
  }
  if (deposit === 0n) throw new ChannelClosedError({ reason: 'channel deposit is zero (settled)' })
  if (payload.cumulativeAmount <= settled)
    throw new VerificationFailedError({
      reason: 'voucher cumulativeAmount is below on-chain settled amount',
    })
  if (payload.cumulativeAmount > deposit)
    throw new AmountExceedsDepositError({ reason: 'voucher amount exceeds on-chain deposit' })
  if (payload.cumulativeAmount < channel.highestVoucherAmount)
    throw new VerificationFailedError({
      reason: 'voucher cumulativeAmount must be strictly greater than highest accepted voucher',
    })
  const valid = await Voucher.verifyVoucher(
    escrow,
    chainId,
    { channelId, cumulativeAmount: payload.cumulativeAmount, signature: payload.signature },
    channel.authorizedSigner,
  )
  if (!valid) throw new InvalidSignatureError({ reason: 'invalid voucher signature' })
  if (payload.cumulativeAmount === channel.highestVoucherAmount)
    return createSessionReceipt({
      challengeId: challenge.id,
      channelId,
      acceptedCumulative: channel.highestVoucherAmount,
      spent: channel.spent,
      units: channel.units,
    })
  const delta = payload.cumulativeAmount - channel.highestVoucherAmount
  if (delta < minVoucherDelta)
    throw new DeltaTooSmallError({
      reason: `voucher delta ${delta} below minimum ${minVoucherDelta}`,
    })
  const updated = await store.updateChannel(channelId, (current) =>
    (() => {
      if (!current) throw new ChannelNotFoundError({ reason: 'channel not found' })
      if (current.finalized) throw new ChannelClosedError({ reason: 'channel is finalized' })
      if (current.closeRequestedAt !== 0n)
        throw new ChannelClosedError({ reason: 'channel has a pending close request' })

      const nextDeposit = deposit > current.deposit ? deposit : current.deposit
      const nextSettled = settled > current.settledOnChain ? settled : current.settledOnChain
      if (payload.cumulativeAmount > current.highestVoucherAmount) {
        return {
          ...current,
          deposit: nextDeposit,
          settledOnChain: nextSettled,
          highestVoucherAmount: payload.cumulativeAmount,
          highestVoucher: {
            channelId,
            cumulativeAmount: payload.cumulativeAmount,
            signature: payload.signature,
          },
        }
      }
      return { ...current, deposit: nextDeposit, settledOnChain: nextSettled }
    })(),
  )
  if (!updated) throw new ChannelNotFoundError({ reason: 'channel not found' })
  return createSessionReceipt({
    challengeId: challenge.id,
    channelId,
    acceptedCumulative: updated.highestVoucherAmount,
    spent: updated.spent,
    units: updated.units,
  })
}

async function handleClose(parameters: {
  store: ChannelStore.ChannelStore
  client: Parameters<typeof sendRawTransaction>[0]
  challenge: Challenge.Challenge
  payload: ParsedSessionCredentialPayload & { action: 'close' }
  chainId: number
  escrow: Address
  account?: viem_Account | undefined
  feePayer?: viem_Account | undefined
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
  feeToken?: Address | undefined
}): Promise<SessionReceipt> {
  const { store, client, challenge, payload, chainId, escrow } = parameters
  const channelId = ChannelStore.normalizeChannelId(payload.channelId)
  assertDescriptor(payload)
  const channel = await store.getChannel(channelId)
  if (!channel) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (!ChannelStore.isPrecompileState(channel))
    throw new VerificationFailedError({ reason: 'channel is not precompile-backed' })
  if (channel.finalized) throw new ChannelClosedError({ reason: 'channel is already finalized' })
  assertSameDescriptor(payload.descriptor, channel.descriptor)
  const state = await Chain.getChannelState(client, channelId, escrow)
  if (state.closeRequestedAt !== 0)
    throw new ChannelClosedError({ reason: 'channel has a pending close request' })
  if (state.deposit === 0n && (payload.cumulativeAmount !== 0n || channel.spent !== 0n))
    throw new ChannelClosedError({ reason: 'channel deposit is zero (settled)' })
  if (payload.cumulativeAmount < channel.spent)
    throw new VerificationFailedError({
      reason: `close voucher amount must be >= ${channel.spent} (spent)`,
    })
  if (payload.cumulativeAmount < state.settled)
    throw new VerificationFailedError({
      reason: `close voucher amount must be >= ${state.settled} (on-chain settled)`,
    })
  const valid = await Voucher.verifyVoucher(
    escrow,
    chainId,
    { channelId, cumulativeAmount: payload.cumulativeAmount, signature: payload.signature },
    channel.authorizedSigner,
  )
  if (!valid) throw new InvalidSignatureError({ reason: 'invalid voucher signature' })
  let captureAmount = uint96(channel.spent > state.settled ? channel.spent : state.settled)
  if (captureAmount > state.deposit)
    throw new AmountExceedsDepositError({ reason: 'close capture amount exceeds on-chain deposit' })
  const pendingCloseStartedAt = BigInt(Math.floor(Date.now() / 1000) || 1)
  const previousCloseRequestedAt = channel.closeRequestedAt
  let pendingCloseMarked = false
  await store.updateChannel(channelId, (current) => {
    if (!current) return null
    if (current.finalized) throw new ChannelClosedError({ reason: 'channel is already finalized' })
    if (current.closeRequestedAt !== 0n)
      throw new ChannelClosedError({ reason: 'channel has a pending close request' })
    if (payload.cumulativeAmount < current.spent)
      throw new VerificationFailedError({
        reason: `close voucher amount must be >= ${current.spent} (spent)`,
      })
    const currentCaptureAmount = uint96(
      current.spent > state.settled ? current.spent : state.settled,
    )
    if (currentCaptureAmount > payload.cumulativeAmount)
      throw new VerificationFailedError({
        reason: `close voucher amount must be >= ${currentCaptureAmount} (capture amount)`,
      })
    if (currentCaptureAmount > state.deposit)
      throw new AmountExceedsDepositError({
        reason: 'close capture amount exceeds on-chain deposit',
      })
    captureAmount = currentCaptureAmount
    pendingCloseMarked = true
    return { ...current, closeRequestedAt: pendingCloseStartedAt }
  })
  const account = parameters.account ?? getClientAccount(client)
  let txHash: Hex | undefined
  let receipt: Awaited<ReturnType<typeof waitForSuccessfulReceipt>>
  try {
    assertSettlementSender({
      operation: 'close',
      channelId,
      operator: channel.operator,
      payee: channel.payee,
      sender: account?.address,
    })
    txHash = await Chain.close(
      client,
      channel.descriptor,
      payload.cumulativeAmount,
      captureAmount,
      payload.signature,
      escrow,
      account
        ? {
            account,
            ...(parameters.feePayer ? { feePayer: parameters.feePayer } : {}),
            ...(parameters.feePayerPolicy ? { feePayerPolicy: parameters.feePayerPolicy } : {}),
            ...(parameters.feeToken ? { feeToken: parameters.feeToken } : {}),
            candidateFeeTokens: [channel.token],
          }
        : undefined,
    )
    receipt = await waitForSuccessfulReceipt(client, txHash)
  } catch (error) {
    if (pendingCloseMarked) {
      await store.updateChannel(channelId, (current) =>
        current && current.closeRequestedAt === pendingCloseStartedAt
          ? { ...current, closeRequestedAt: previousCloseRequestedAt }
          : current,
      )
    }
    throw error
  }
  const closed = getChannelEvent(receipt, 'ChannelClosed', channelId)
  const settledToPayee = uint96(closed.args.settledToPayee as bigint)
  const refundedToPayer = uint96(closed.args.refundedToPayer as bigint)
  if (settledToPayee > captureAmount || settledToPayee + refundedToPayer > state.deposit)
    throw new VerificationFailedError({ reason: 'ChannelClosed amounts do not match state' })
  const updated = await store.updateChannel(channelId, (current) =>
    current
      ? {
          ...current,
          finalized: true,
          closeRequestedAt: 0n,
          deposit: 0n,
          settledOnChain:
            captureAmount > current.settledOnChain ? captureAmount : current.settledOnChain,
          ...(payload.cumulativeAmount > current.highestVoucherAmount
            ? {
                highestVoucherAmount: payload.cumulativeAmount,
                highestVoucher: {
                  channelId,
                  cumulativeAmount: payload.cumulativeAmount,
                  signature: payload.signature,
                },
              }
            : {}),
        }
      : current,
  )
  return createSessionReceipt({
    challengeId: challenge.id,
    channelId,
    acceptedCumulative: payload.cumulativeAmount,
    spent: updated?.spent ?? channel.spent,
    units: updated?.units ?? channel.units,
    txHash,
  })
}

/** Settles the highest accepted voucher for a precompile-backed session channel. */
export async function settle(
  store_: Store.Store<any> | ChannelStore.ChannelStore,
  client: Parameters<typeof sendRawTransaction>[0],
  channelId_: Hex,
  options?: {
    account?: viem_Account | undefined
    candidateFeeTokens?: readonly Address[] | undefined
    escrow?: Address | undefined
    feePayer?: viem_Account | undefined
    feePayerPolicy?: Partial<FeePayer.Policy> | undefined
    feeToken?: Address | undefined
  },
): Promise<Hex> {
  const store = 'getChannel' in store_ ? store_ : ChannelStore.fromStore(store_ as never)
  const channelId = ChannelStore.normalizeChannelId(channelId_)
  const channel = await store.getChannel(channelId)
  if (!channel) throw new ChannelNotFoundError({ reason: 'channel not found' })
  if (!ChannelStore.isPrecompileState(channel))
    throw new VerificationFailedError({ reason: 'channel is not precompile-backed' })
  if (!channel.highestVoucher) throw new VerificationFailedError({ reason: 'no voucher to settle' })
  const escrow = options?.escrow ?? channel.escrowContract
  const account = options?.account ?? getClientAccount(client)
  assertSettlementSender({
    operation: 'settle',
    channelId,
    operator: channel.operator,
    payee: channel.payee,
    sender: account?.address,
  })
  const amount = uint96(channel.highestVoucher.cumulativeAmount)
  const txHash = await Chain.settle(
    client,
    channel.descriptor,
    amount,
    channel.highestVoucher.signature,
    escrow,
    account
      ? {
          account,
          ...(options?.feePayer ? { feePayer: options.feePayer } : {}),
          ...(options?.feePayerPolicy ? { feePayerPolicy: options.feePayerPolicy } : {}),
          ...(options?.feeToken ? { feeToken: options.feeToken } : {}),
          candidateFeeTokens: options?.candidateFeeTokens ?? [channel.token],
        }
      : undefined,
  )
  const receipt = await waitForSuccessfulReceipt(client, txHash)
  const settled = getChannelEvent(receipt, 'Settled', channelId)
  const newSettled = uint96(settled.args.newSettled as bigint)
  if (newSettled < amount)
    throw new VerificationFailedError({ reason: 'Settled event is below voucher amount' })
  const state = await Chain.getChannelState(client, channelId, escrow)
  if (state.settled !== newSettled)
    throw new VerificationFailedError({
      reason: 'on-chain channel state does not match settle receipt',
    })
  await store.updateChannel(channelId, (current) =>
    current
      ? {
          ...current,
          settledOnChain: newSettled > current.settledOnChain ? newSettled : current.settledOnChain,
        }
      : current,
  )
  return txHash
}

export namespace session {
  export type Parameters = {
    amount?: string | undefined
    chainId?: number | undefined
    channelStateTtl?: number | undefined
    currency?: Address | undefined
    decimals?: number | undefined
    escrow?: Address | undefined
    getClient?: Client.getResolver.Parameters['getClient'] | undefined
    minVoucherDelta?: string | undefined
    recipient?: Address | undefined
    /**
     * Atomic store backend for channel state.
     *
     * Session mutations must be linearizable across instances so spent,
     * highest-voucher, top-up, and close/finalization updates cannot race.
     * Use `Store.memory()` for tests or local single-process usage.
     */
    store?: Store.AtomicStore | undefined
    suggestedDeposit?: string | undefined
    unitType?: string | undefined
    /** Account used for server-driven close transactions. Defaults to the client account. */
    account?: viem_Account | undefined
    /** Optional fee payer used to sponsor server-driven close transactions. */
    feePayer?: viem_Account | undefined
    /** Optional fee-payer policy limits for server-driven close transactions. */
    feePayerPolicy?: Partial<FeePayer.Policy> | undefined
    /** Optional fee token used for server-driven close transactions. */
    feeToken?: Address | undefined
  }

  export type Defaults = LooseOmit<
    Method.RequestDefaults<typeof Methods.session>,
    'feePayer' | 'escrowContract'
  >

  export type DeriveDefaults<parameters extends Parameters> = types.DeriveDefaults<
    parameters,
    Defaults
  >
}
