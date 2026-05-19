import type { Account, Address, Client as ViemClient, Hex } from 'viem'
import { tempo as tempo_chain } from 'viem/chains'
import { Transaction } from 'viem/tempo'

import {
  AmountExceedsDepositError,
  ChannelClosedError,
  ChannelNotFoundError,
  VerificationFailedError,
} from '../../Errors.js'
import type { NoExtraKeys } from '../../internal/types.js'
import * as Method from '../../Method.js'
import type * as Receipt_ from '../../Receipt.js'
import * as Store from '../../Store.js'
import * as Client from '../../viem/Client.js'
import * as AuthorizeReceipt from '../authorize/Receipt.js'
import * as AuthorizeStore from '../authorize/Store.js'
import type { Authorization, Receipt } from '../authorize/Types.js'
import * as AccountResolver from '../internal/account.js'
import * as defaults from '../internal/defaults.js'
import * as FeePayer from '../internal/fee-payer.js'
import type * as types from '../internal/types.js'
import * as Methods from '../Methods.js'
import * as Chain from '../precompile/Chain.js'
import * as Channel from '../precompile/Channel.js'
import { tip20ChannelEscrow } from '../precompile/Constants.js'
import { uint96 } from '../precompile/Types.js'
import * as Voucher from '../precompile/Voucher.js'

type AuthorizeRequest = ReturnType<typeof Methods.authorize.schema.request.parse>
type AuthorizeMethodDetails = NonNullable<AuthorizeRequest['methodDetails']>

/** Creates a Tempo authorize method for deferred TIP-20 captures. */
export function authorize<const parameters extends authorize.Parameters>(
  p: NoExtraKeys<parameters, authorize.Parameters>,
) {
  const parameters = p as parameters
  const {
    amount,
    currency = defaults.resolveCurrency(parameters),
    decimals = defaults.decimals,
    description,
    externalId,
    store: rawStore = Store.memory(),
  } = parameters
  const { account, recipient, feePayer, feePayerUrl } = AccountResolver.resolve(parameters)
  const operator = addressOf(parameters.operator ?? account)
  const authorizedSigner = addressOf(parameters.authorizedSigner ?? account)
  if (!recipient) throw new Error('tempo.authorize() requires a recipient.')
  if (!operator) throw new Error('tempo.authorize() requires an operator or account.')
  if (!authorizedSigner)
    throw new Error('tempo.authorize() requires an authorizedSigner or account.')

  const store = AuthorizeStore.fromStore(rawStore, { keyPrefix: parameters.keyPrefix })
  const getClient = Client.getResolver({
    chain: tempo_chain,
    feePayerUrl,
    getClient: parameters.getClient,
    rpcUrl: defaults.rpcUrl,
  })

  type Defaults = authorize.DeriveDefaults<parameters>
  return Method.toServer<typeof Methods.authorize, Defaults>(Methods.authorize, {
    defaults: {
      amount,
      authorizedSigner,
      currency,
      decimals,
      description,
      externalId,
      operator,
      recipient,
    } as unknown as Defaults,

    async request({ credential, request }) {
      const chainId = await (async () => {
        if (request.chainId) return request.chainId
        if (parameters.chainId) return parameters.chainId
        return (await getClient({})).chain?.id
      })()
      if (!chainId) throw new Error('No chainId configured for tempo.authorize().')

      const client = await getClient({ chainId })
      if (client.chain?.id !== chainId)
        throw new Error(`Client not configured with chainId ${chainId}.`)

      const resolvedFeePayer = (() => {
        if (request.feePayer === false) return credential ? false : undefined
        const requested = typeof request.feePayer === 'object' ? request.feePayer : feePayer
        if (credential) return requested ?? (feePayerUrl ? true : undefined)
        if (requested ?? feePayerUrl) return true
        return undefined
      })()

      return {
        ...request,
        chainId,
        escrowContract: request.escrowContract ?? parameters.escrowContract ?? tip20ChannelEscrow,
        feePayer: resolvedFeePayer,
      }
    },

    async verify({ credential, request }) {
      const context = parseAuthorizeVerification({
        payload: credential.payload,
        request,
      })
      const { amount, channelId, chainId, escrow, methodDetails, payload, resolvedRequest } =
        context
      const client = await getClient({ chainId })
      const result = await Chain.broadcastOpenTransaction({
        async beforeBroadcast({ openDeposit }) {
          if (openDeposit !== amount)
            throw new VerificationFailedError({
              reason: 'TIP-1034 authorize deposit does not match challenge',
            })
          if (await store.get(channelId))
            throw new VerificationFailedError({
              reason: 'authorization credential has already been used',
            })
        },
        challengeExpires: credential.challenge.expires,
        chainId,
        client,
        escrowContract: escrow,
        expectedAuthorizedSigner: methodDetails.authorizedSigner as Address,
        expectedChannelId: channelId,
        expectedCurrency: resolvedRequest.currency as Address,
        expectedExpiringNonceHash: context.expiringNonceHash,
        expectedOperator: methodDetails.operator as Address,
        expectedPayee: resolvedRequest.recipient as Address,
        expectedPayer: context.payer,
        feePayer: methodDetails.feePayer === true ? feePayer : undefined,
        feePayerPolicy: parameters.feePayerPolicy,
        serializedTransaction: payload.transaction as Hex,
      })
      if (result.state.deposit !== amount || result.state.settled !== 0n)
        throw new VerificationFailedError({
          reason: 'authorize channel state does not match challenge',
        })

      const authorization: Authorization = {
        amount: amount.toString(),
        capturedAmount: '0',
        challengeId: credential.challenge.id,
        channel: {
          chainId,
          descriptor: result.descriptor,
          escrow,
          id: channelId,
        },
        openTxHash: result.txHash,
        status: 'authorized',
      }
      const created = await store.create(authorization)
      if (created === 'exists')
        throw new VerificationFailedError({
          reason: 'authorization credential has already been used',
        })

      return {
        response: Response.json(
          {
            authorization: toMetadata(authorization),
          },
          {
            headers: { 'Cache-Control': 'no-store' },
          },
        ),
      } as never
    },
  })
}

function parseAuthorizeVerification(parameters: { payload: unknown; request: unknown }) {
  const parsedPayload = Methods.authorize.schema.credential.payload.safeParse(parameters.payload)
  if (!parsedPayload.success)
    throw new VerificationFailedError({ reason: 'authorize credential payload is invalid' })
  const parsed = Methods.authorize.schema.request.safeParse(parameters.request)
  if (!parsed.success) throw new VerificationFailedError({ reason: 'authorize request is invalid' })

  const payload = parsedPayload.data
  const resolvedRequest = parsed.data
  const methodDetails = resolvedRequest.methodDetails as AuthorizeMethodDetails
  const chainId = methodDetails.chainId
  if (!chainId) throw new VerificationFailedError({ reason: 'authorize chainId is missing' })

  const transaction = deserializeAuthorizeTransaction(payload.transaction)
  if (!transaction.from)
    throw new VerificationFailedError({ reason: 'authorize transaction has no payer' })

  return {
    amount: uint96(BigInt(resolvedRequest.amount)),
    channelId: payload.channelId as Hex,
    chainId,
    escrow: methodDetails.escrowContract ?? tip20ChannelEscrow,
    expiringNonceHash: Channel.computeExpiringNonceHash(
      transaction as Channel.ExpiringNonceTransaction,
      { sender: transaction.from },
    ),
    methodDetails,
    payer: transaction.from,
    payload,
    resolvedRequest,
  }
}

function deserializeAuthorizeTransaction(transaction: string) {
  try {
    return Transaction.deserialize(transaction as Transaction.TransactionSerializedTempo)
  } catch {
    throw new VerificationFailedError({ reason: 'authorize transaction is invalid' })
  }
}

/** Capture an amount against a Tempo authorization. */
export async function capture(
  store_: Store.AtomicStore | AuthorizeStore.AuthorizationStore,
  client: ViemClient,
  authorizationId: Hex,
  options: capture.Options,
): Promise<Receipt> {
  const store =
    'create' in store_ ? store_ : AuthorizeStore.fromStore(store_, { keyPrefix: options.keyPrefix })
  const authorization = await store.get(authorizationId)
  if (!authorization) throw new ChannelNotFoundError({ reason: 'authorization not found' })
  const existing = AuthorizeStore.getCaptureReceipt(authorization, options.idempotencyKey)
  if (existing) return existing
  assertActive(authorization)

  const delta = uint96(BigInt(options.amount))
  const previous = BigInt(authorization.capturedAmount)
  const cumulative = uint96(previous + delta)
  const limit = BigInt(authorization.amount)
  if (cumulative > limit)
    throw new AmountExceedsDepositError({ reason: 'capture exceeds authorized amount' })

  const state = await Chain.getChannelState(
    client,
    authorization.channel.id,
    authorization.channel.escrow,
  )
  if (state.closeRequestedAt !== 0)
    throw new ChannelClosedError({ reason: 'authorization has a pending close request' })
  if (cumulative <= state.settled)
    throw new VerificationFailedError({
      reason: 'capture amount must exceed on-chain settled amount',
    })

  const signer = options.authorizedSigner ?? options.account ?? client.account
  if (!signer) throw new Error('Cannot capture authorization: no signer account available.')
  const signature = await Voucher.signVoucher(
    client,
    signer,
    { channelId: authorization.channel.id, cumulativeAmount: cumulative },
    authorization.channel.escrow,
    authorization.channel.chainId,
    authorization.channel.descriptor.authorizedSigner,
  )

  const account = options.account ?? client.account
  const txHash = options.close
    ? await Chain.closeOnChain(
        client,
        authorization.channel.descriptor,
        cumulative,
        cumulative,
        signature,
        authorization.channel.escrow,
        account
          ? {
              account,
              ...(options.feePayer ? { feePayer: options.feePayer } : {}),
              ...(options.feePayerPolicy ? { feePayerPolicy: options.feePayerPolicy } : {}),
              ...(options.feeToken ? { feeToken: options.feeToken } : {}),
              candidateFeeTokens: options.candidateFeeTokens ?? [
                authorization.channel.descriptor.token,
              ],
            }
          : undefined,
      )
    : await Chain.settleOnChain(
        client,
        authorization.channel.descriptor,
        cumulative,
        signature,
        authorization.channel.escrow,
        account
          ? {
              account,
              ...(options.feePayer ? { feePayer: options.feePayer } : {}),
              ...(options.feePayerPolicy ? { feePayerPolicy: options.feePayerPolicy } : {}),
              ...(options.feeToken ? { feeToken: options.feeToken } : {}),
              candidateFeeTokens: options.candidateFeeTokens ?? [
                authorization.channel.descriptor.token,
              ],
            }
          : undefined,
      )
  const receipt = await Chain.waitForSuccessfulReceipt(client, txHash)
  const event = Chain.getChannelEvent(
    receipt,
    options.close ? 'ChannelClosed' : 'Settled',
    authorization.channel.id,
  )
  const newCaptured = options.close
    ? uint96(event.args.settledToPayee as bigint)
    : uint96(event.args.newSettled as bigint)
  if (newCaptured < cumulative)
    throw new VerificationFailedError({ reason: 'capture receipt settled less than requested' })

  const captureReceipt = AuthorizeReceipt.create({
    authorizationId: authorization.channel.id,
    capturedAmount: newCaptured,
    delta: newCaptured - previous,
    reference: txHash,
  })

  return store.update(authorization.channel.id, (current) => {
    if (!current) throw new ChannelNotFoundError({ reason: 'authorization not found' })
    const existingReceipt = AuthorizeStore.getCaptureReceipt(current, options.idempotencyKey)
    if (existingReceipt) return { op: 'noop', result: existingReceipt }

    const currentCaptured = BigInt(current.capturedAmount)
    const nextCaptured = currentCaptured > newCaptured ? currentCaptured : newCaptured
    const receipts = options.idempotencyKey
      ? {
          ...(current.captureReceipts ?? {}),
          [options.idempotencyKey]: captureReceipt,
        }
      : current.captureReceipts
    return {
      op: 'set',
      value: {
        ...current,
        capturedAmount: nextCaptured.toString(),
        ...(receipts ? { captureReceipts: receipts } : {}),
        ...(options.close ? { status: 'closed' as const } : {}),
      },
      result: captureReceipt,
    }
  })
}

/** Void a Tempo authorization without increasing captured value. */
export async function voidAuthorization(
  store_: Store.AtomicStore | AuthorizeStore.AuthorizationStore,
  client: ViemClient,
  authorizationId: Hex,
  options: voidAuthorization.Options = {},
): Promise<{ authorizationId: Hex; reference: Hex; releasedAmount: string; status: 'voided' }> {
  const store =
    'create' in store_ ? store_ : AuthorizeStore.fromStore(store_, { keyPrefix: options.keyPrefix })
  const authorization = await store.get(authorizationId)
  if (!authorization) throw new ChannelNotFoundError({ reason: 'authorization not found' })
  assertActive(authorization)

  const captured = uint96(BigInt(authorization.capturedAmount))
  const account = options.account ?? client.account
  const txHash = await Chain.closeOnChain(
    client,
    authorization.channel.descriptor,
    captured,
    captured,
    '0x',
    authorization.channel.escrow,
    account
      ? {
          account,
          ...(options.feePayer ? { feePayer: options.feePayer } : {}),
          ...(options.feePayerPolicy ? { feePayerPolicy: options.feePayerPolicy } : {}),
          ...(options.feeToken ? { feeToken: options.feeToken } : {}),
          candidateFeeTokens: options.candidateFeeTokens ?? [
            authorization.channel.descriptor.token,
          ],
        }
      : undefined,
  )
  const receipt = await Chain.waitForSuccessfulReceipt(client, txHash)
  const closed = Chain.getChannelEvent(receipt, 'ChannelClosed', authorization.channel.id)
  const releasedAmount = uint96(closed.args.refundedToPayer as bigint)
  await store.update(authorization.channel.id, (current) => {
    if (!current) throw new ChannelNotFoundError({ reason: 'authorization not found' })
    return {
      op: 'set',
      value: { ...current, status: 'voided' },
      result: undefined,
    }
  })
  return {
    authorizationId: authorization.channel.id,
    reference: txHash,
    releasedAmount: releasedAmount.toString(),
    status: 'voided',
  }
}

function addressOf(value: Account | Address | undefined): Address | undefined {
  if (!value) return undefined
  return typeof value === 'object' ? value.address : value
}

function assertActive(authorization: Authorization) {
  if (authorization.status !== 'authorized')
    throw new ChannelClosedError({ reason: `authorization is ${authorization.status}` })
}

function toMetadata(authorization: Authorization) {
  const capturedAmount = BigInt(authorization.capturedAmount)
  const amount = BigInt(authorization.amount)
  return {
    id: authorization.channel.id,
    method: 'tempo',
    status: authorization.status,
    amount: authorization.amount,
    capturedAmount: authorization.capturedAmount,
    remainingAmount: (amount - capturedAmount).toString(),
    currency: authorization.channel.descriptor.token,
    recipient: authorization.channel.descriptor.payee,
    operator: authorization.channel.descriptor.operator,
    authorizedSigner: authorization.channel.descriptor.authorizedSigner,
    reference: authorization.openTxHash,
  }
}

export declare namespace authorize {
  type Defaults = Method.RequestDefaults<typeof Methods.authorize>

  type FeePayerPolicy = Partial<FeePayer.Policy>

  type Parameters = {
    account?: Account | Address | undefined
    authorizedSigner?: Account | Address | undefined
    chainId?: number | undefined
    escrowContract?: Address | undefined
    feePayer?: Account | string | true | undefined
    feePayerPolicy?: FeePayerPolicy | undefined
    operator?: Account | Address | undefined
    recipient?: Address | undefined
    store?: Store.AtomicStore | undefined
    keyPrefix?: string | undefined
  } & Client.getResolver.Parameters &
    Defaults

  type DeriveDefaults<parameters extends Parameters> = types.DeriveDefaults<parameters, Defaults> &
    (parameters extends { account: Account | Address }
      ? { authorizedSigner: Address; operator: Address }
      : {}) & { decimals: number }
}

export declare namespace capture {
  type Options = {
    account?: Account | undefined
    amount: string | bigint
    authorizedSigner?: Account | undefined
    candidateFeeTokens?: readonly Address[] | undefined
    close?: boolean | undefined
    feePayer?: Account | undefined
    feePayerPolicy?: authorize.FeePayerPolicy | undefined
    feeToken?: Address | undefined
    idempotencyKey?: string | undefined
    keyPrefix?: string | undefined
  }
}

export declare namespace voidAuthorization {
  type Options = {
    account?: Account | undefined
    candidateFeeTokens?: readonly Address[] | undefined
    feePayer?: Account | undefined
    feePayerPolicy?: authorize.FeePayerPolicy | undefined
    feeToken?: Address | undefined
    keyPrefix?: string | undefined
  }
}

const _receiptTypeCheck = undefined as unknown as Receipt extends Receipt_.Receipt ? true : never
void _receiptTypeCheck
