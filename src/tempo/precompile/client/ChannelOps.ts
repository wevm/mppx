/**
 * Shared client-side precompile channel operations.
 *
 * Provides the low-level helpers that both `precompile.session()` and
 * `precompile.sessionManager()` rely on: channel ID computation,
 * transaction-bound descriptor construction, on-chain open/top-up payload
 * construction, voucher/close payload serialization, and transaction signing.
 */
import { Hex } from 'ox'
import { encodeFunctionData, zeroAddress, type Account, type Address, type Client } from 'viem'
import { prepareTransactionRequest, signTransaction } from 'viem/actions'

import * as Channel from '../Channel.js'
import { tip20ChannelEscrow } from '../Constants.js'
import { escrowAbi } from '../escrow.abi.js'
import type { SessionCredentialPayload } from '../Types.js'
import * as Voucher from '../Voucher.js'

function voucherAuthorizedSigner(address: Address): Address | undefined {
  return address.toLowerCase() === zeroAddress ? undefined : address
}

function defaultAuthorizedSigner(account: Account): Address {
  return (account as unknown as { accessKeyAddress?: Address }).accessKeyAddress ?? account.address
}

/** Signs and creates a TIP-1034 voucher credential payload for an existing channel. */
export async function createVoucherPayload(
  client: Client,
  account: Account,
  descriptor: Channel.ChannelDescriptor,
  cumulativeAmount: bigint,
  chainId: number,
): Promise<SessionCredentialPayload> {
  const channelId = Channel.computeId({
    ...descriptor,
    chainId,
    escrow: tip20ChannelEscrow,
  })
  const signature = await Voucher.signVoucher(
    client,
    account,
    { channelId, cumulativeAmount },
    tip20ChannelEscrow,
    chainId,
    voucherAuthorizedSigner(descriptor.authorizedSigner),
  )

  return {
    action: 'voucher',
    channelId,
    descriptor,
    cumulativeAmount: cumulativeAmount.toString(),
    signature,
  }
}

/** Signs and creates a TIP-1034 close credential payload for an existing channel. */
export async function createClosePayload(
  client: Client,
  account: Account,
  descriptor: Channel.ChannelDescriptor,
  cumulativeAmount: bigint,
  chainId: number,
): Promise<SessionCredentialPayload> {
  const voucher = await createVoucherPayload(client, account, descriptor, cumulativeAmount, chainId)
  if (voucher.action !== 'voucher') throw new Error('expected voucher payload')
  return {
    action: 'close',
    channelId: voucher.channelId,
    descriptor,
    cumulativeAmount: voucher.cumulativeAmount,
    signature: voucher.signature,
  }
}

/**
 * Prepares, signs, and creates a TIP-1034 open credential payload.
 */
export async function createOpenPayload(
  client: Client,
  account: Account,
  parameters: {
    authorizedSigner?: Address | undefined
    chainId: number
    deposit: bigint
    feePayer?: boolean | undefined
    initialAmount: bigint
    operator?: Address | undefined
    payee: Address
    token: Address
  },
): Promise<SessionCredentialPayload> {
  const authorizedSigner = parameters.authorizedSigner ?? defaultAuthorizedSigner(account)
  const operator = parameters.operator ?? '0x0000000000000000000000000000000000000000'
  const salt = Hex.random(32)

  const openData = encodeFunctionData({
    abi: escrowAbi,
    functionName: 'open',
    args: [parameters.payee, operator, parameters.token, parameters.deposit, salt, authorizedSigner],
  })
  const prepared = await prepareTransactionRequest(client, {
    account,
    calls: [{ to: tip20ChannelEscrow, data: openData }],
    ...(parameters.feePayer ? { feePayer: true } : {}),
    feeToken: parameters.token,
  } as never)

  const expiringNonceHash = Channel.computeExpiringNonceHash(
    prepared as Channel.ExpiringNonceTransaction,
    { sender: account.address },
  )
  const descriptor = {
    authorizedSigner,
    expiringNonceHash,
    operator,
    payee: parameters.payee,
    payer: account.address,
    salt,
    token: parameters.token,
  } satisfies Channel.ChannelDescriptor
  const channelId = Channel.computeId({
    ...descriptor,
    chainId: parameters.chainId,
    escrow: tip20ChannelEscrow,
  })
  const signature = await Voucher.signVoucher(
    client,
    account,
    { channelId, cumulativeAmount: parameters.initialAmount },
    tip20ChannelEscrow,
    parameters.chainId,
    voucherAuthorizedSigner(authorizedSigner),
  )
  const transaction = (await signTransaction(client, prepared as never)) as Hex.Hex

  return {
    action: 'open',
    type: 'transaction',
    channelId,
    transaction,
    signature,
    descriptor,
    cumulativeAmount: parameters.initialAmount.toString(),
    authorizedSigner: descriptor.authorizedSigner,
  }
}

/** Prepares, signs, and creates a TIP-1034 top-up credential payload. */
export async function createTopUpPayload(
  client: Client,
  account: Account,
  descriptor: Channel.ChannelDescriptor,
  additionalDeposit: bigint,
  chainId: number,
  feePayer?: boolean | undefined,
): Promise<SessionCredentialPayload> {
  const channelId = Channel.computeId({
    ...descriptor,
    chainId,
    escrow: tip20ChannelEscrow,
  })
  const prepared = await prepareTransactionRequest(client, {
    account,
    calls: [
      {
        to: tip20ChannelEscrow,
        data: encodeFunctionData({
          abi: escrowAbi,
          functionName: 'topUp',
          args: [descriptor, additionalDeposit],
        }),
      },
    ],
    ...(feePayer ? { feePayer: true } : {}),
    feeToken: descriptor.token,
  } as never)
  const transaction = (await signTransaction(client, prepared as never)) as Hex.Hex

  return {
    action: 'topUp',
    type: 'transaction',
    channelId,
    transaction,
    descriptor,
    additionalDeposit: additionalDeposit.toString(),
  }
}
