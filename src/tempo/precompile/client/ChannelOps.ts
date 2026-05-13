import { Hex } from 'ox'
import type { Account, Address, Client } from 'viem'
import { prepareTransactionRequest, signTransaction } from 'viem/actions'

import * as Chain from '../Chain.js'
import * as Channel from '../Channel.js'
import { tip20ChannelEscrow } from '../Constants.js'
import type { Uint96 } from '../Types.js'
import * as Voucher from '../Voucher.js'

export type OpenResult = {
  channelId: Hex.Hex
  descriptor: Channel.ChannelDescriptor
  transaction: Hex.Hex
  voucherSignature: Hex.Hex
}

/**
 * Prepares and signs a one-call TIP-1034 channel-open transaction, computes the
 * transaction-bound `expiringNonceHash` via viem, and signs the initial voucher.
 */
export async function createOpen(
  client: Client,
  account: Account,
  parameters: {
    authorizedSigner?: Address | undefined
    chainId: number
    deposit: Uint96
    escrow?: Address | undefined
    initialAmount: Uint96
    operator?: Address | undefined
    payee: Address
    token: Address
  },
): Promise<OpenResult> {
  const escrow = parameters.escrow ?? tip20ChannelEscrow
  const authorizedSigner = parameters.authorizedSigner ?? account.address
  const operator = parameters.operator ?? '0x0000000000000000000000000000000000000000'
  const salt = Hex.random(32)

  const openData = Chain.encodeOpen({
    authorizedSigner,
    deposit: parameters.deposit,
    operator,
    payee: parameters.payee,
    salt,
    token: parameters.token,
  })
  const prepared = await prepareTransactionRequest(client, {
    account,
    calls: [{ to: escrow, data: openData }],
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
  const channelId = Channel.computeId(descriptor, { chainId: parameters.chainId, escrow })
  const voucherSignature = await Voucher.sign(
    client,
    account,
    { channelId, cumulativeAmount: parameters.initialAmount },
    {
      authorizedSigner: parameters.authorizedSigner,
      chainId: parameters.chainId,
      verifyingContract: escrow,
    },
  )
  const transaction = (await signTransaction(client, prepared as never)) as Hex.Hex

  return { channelId, descriptor, transaction, voucherSignature }
}
