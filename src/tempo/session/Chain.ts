import {
  type Account,
  type Address,
  type Client,
  decodeFunctionData,
  encodeFunctionData,
  getAbiItem,
  type Hex,
  type ReadContractReturnType,
  toFunctionSelector,
} from 'viem'
import {
  call,
  prepareTransactionRequest,
  readContract,
  sendRawTransaction,
  sendRawTransactionSync,
  signTransaction,
  writeContract,
} from 'viem/actions'
import { Transaction } from 'viem/tempo'
import { BadRequestError, ChannelClosedError, VerificationFailedError } from '../../Errors.js'
import * as TempoAddress from '../internal/address.js'
import * as defaults from '../internal/defaults.js'
import { isTempoTransaction } from '../internal/fee-payer.js'
import * as Channel from './Channel.js'
import { escrowAbi } from './escrow.abi.js'
import type { SignedVoucher } from './Types.js'

export { escrowAbi }

/**
 * Asserts that a deserialized transaction has an existing sender signature —
 * required before fee payer co-signing to prevent the fee payer from becoming
 * the sender.
 */
function assertSenderSigned(transaction: any): void {
  if (!transaction.signature || !transaction.from)
    throw new BadRequestError({
      reason: 'Transaction must be signed by the sender before fee payer co-signing',
    })
}

const UINT128_MAX = 2n ** 128n - 1n

/**
 * On-chain channel state from the escrow contract.
 */
export type OnChainChannel = ReadContractReturnType<typeof escrowAbi, 'getChannel'>

/**
 * Read channel state from the escrow contract.
 */
export async function getOnChainChannel(
  client: Client,
  escrowContract: Address,
  channelId: Hex,
): Promise<OnChainChannel> {
  return readContract(client, {
    address: escrowContract,
    abi: escrowAbi,
    functionName: 'getChannel',
    args: [channelId],
  })
}

/**
 * Verify a topUp by re-reading on-chain channel state.
 */
export async function verifyTopUpTransaction(
  client: Client,
  escrowContract: Address,
  channelId: Hex,
  previousDeposit: bigint,
): Promise<{ deposit: bigint }> {
  const channel = await getOnChainChannel(client, escrowContract, channelId)

  if (channel.finalized) {
    throw new ChannelClosedError({ reason: 'channel is finalized on-chain' })
  }

  if (channel.deposit <= previousDeposit) {
    throw new VerificationFailedError({ reason: 'channel deposit did not increase' })
  }

  return { deposit: channel.deposit }
}

function assertUint128(amount: bigint): void {
  if (amount < 0n || amount > UINT128_MAX) {
    throw new VerificationFailedError({ reason: 'cumulativeAmount exceeds uint128 range' })
  }
}

/**
 * Submit a settle transaction on-chain.
 */
export async function settleOnChain(
  client: Client,
  escrowContract: Address,
  voucher: SignedVoucher,
  feePayer?: Account | undefined,
): Promise<Hex> {
  assertUint128(voucher.cumulativeAmount)
  const args = [voucher.channelId, voucher.cumulativeAmount, voucher.signature] as const
  if (feePayer) {
    const data = encodeFunctionData({ abi: escrowAbi, functionName: 'settle', args })
    return sendFeePayerTx(client, feePayer, escrowContract, data, 'settle')
  }
  return writeContract(client, {
    account: client.account!,
    chain: client.chain,
    address: escrowContract,
    abi: escrowAbi,
    functionName: 'settle',
    args,
  })
}

/**
 * Submit a close transaction on-chain.
 */
export async function closeOnChain(
  client: Client,
  escrowContract: Address,
  voucher: SignedVoucher,
  account?: Account,
  feePayer?: Account | undefined,
): Promise<Hex> {
  assertUint128(voucher.cumulativeAmount)
  const resolved = account ?? client.account
  if (!resolved)
    throw new Error(
      'Cannot close channel: no account available. Provide an `account` in the session config or a `getClient` that returns an account-bearing client.',
    )
  const args = [voucher.channelId, voucher.cumulativeAmount, voucher.signature] as const
  if (feePayer) {
    const data = encodeFunctionData({ abi: escrowAbi, functionName: 'close', args })
    return sendFeePayerTx(client, feePayer, escrowContract, data, 'close')
  }
  return writeContract(client, {
    account: resolved,
    chain: client.chain,
    address: escrowContract,
    abi: escrowAbi,
    functionName: 'close',
    args,
  })
}

/**
 * Build, sign, and broadcast a fee-sponsored type-0x76 transaction.
 *
 * Follows the same signTransaction + sendRawTransactionSync pattern used
 * by broadcastOpenTransaction / broadcastTopUpTransaction, but originates
 * the transaction server-side (estimating gas and fees first).
 */
async function sendFeePayerTx(
  client: Client,
  feePayer: Account,
  to: Address,
  data: Hex,
  label: string,
): Promise<Hex> {
  // Resolve the fee token for this chain so the tx pays gas in the correct
  // token.  Use expiring nonces for replay protection.
  const chainId = client.chain?.id
  const feeToken = chainId
    ? defaults.currency[chainId as keyof typeof defaults.currency]
    : undefined

  const prepared = await prepareTransactionRequest(client, {
    account: feePayer,
    calls: [{ to, data }],
    nonceKey: 'expiring',
    ...(feeToken ? { feeToken } : {}),
  } as never)

  const serialized = (await signTransaction(client, {
    ...prepared,
    account: feePayer,
  } as never)) as Hex

  const receipt = await sendRawTransactionSync(client, {
    serializedTransaction: serialized as Transaction.TransactionSerializedTempo,
  })

  if (receipt.status !== 'success') {
    throw new VerificationFailedError({
      reason: `${label} transaction reverted: ${receipt.transactionHash}`,
    })
  }

  return receipt.transactionHash
}

const escrowOpenSelector = /*#__PURE__*/ toFunctionSelector(
  getAbiItem({ abi: escrowAbi, name: 'open' }),
)

const escrowTopUpSelector = /*#__PURE__*/ toFunctionSelector(
  getAbiItem({ abi: escrowAbi, name: 'topUp' }),
)

const erc20ApproveSelector = /*#__PURE__*/ toFunctionSelector(
  'function approve(address spender, uint256 amount)',
)

export type BroadcastResult = {
  txHash: Hex | undefined
  onChain: OnChainChannel
}

export async function broadcastOpenTransaction(parameters: {
  client: Client
  serializedTransaction: Hex
  escrowContract: Address
  channelId: Hex
  recipient: Address
  currency: Address
  feePayer?: Account | undefined
  /** When false, simulates instead of waiting for confirmation and returns derived on-chain state. @default true */
  waitForConfirmation?: boolean | undefined
}): Promise<BroadcastResult> {
  const {
    client,
    serializedTransaction,
    escrowContract,
    channelId,
    recipient,
    currency,
    feePayer,
    waitForConfirmation = true,
  } = parameters

  if (feePayer && !isTempoTransaction(serializedTransaction))
    throw new BadRequestError({
      reason: 'Only Tempo (0x76/0x78) transactions are supported',
    })

  const transaction = Transaction.deserialize(
    serializedTransaction as Transaction.TransactionSerializedTempo,
  )

  if (feePayer) assertSenderSigned(transaction)

  const calls = transaction.calls ?? []

  const openCall = calls.find((call) => {
    if (!call.to || !TempoAddress.isEqual(call.to, escrowContract)) return false
    if (!call.data) return false
    return call.data.slice(0, 10) === escrowOpenSelector
  })

  if (!openCall)
    throw new BadRequestError({
      reason: 'transaction does not contain a valid escrow open call',
    })

  if (feePayer) {
    for (const call of calls) {
      if (!call.to || !call.data) {
        throw new BadRequestError({
          reason: 'fee-sponsored transactions must not contain calls without target or data',
        })
      }
      const selector = call.data.slice(0, 10)
      const isEscrowOpen =
        TempoAddress.isEqual(call.to, escrowContract) && selector === escrowOpenSelector
      const isTokenApprove =
        TempoAddress.isEqual(call.to, currency) && selector === erc20ApproveSelector
      if (!isEscrowOpen && !isTokenApprove) {
        throw new BadRequestError({
          reason: 'fee-sponsored open transaction contains an unauthorized call',
        })
      }
    }
  }

  const { args: openArgs } = decodeFunctionData({ abi: escrowAbi, data: openCall.data! })
  const [payee, token, deposit, salt, authorizedSigner] = openArgs as readonly [
    Address,
    Address,
    bigint,
    Hex,
    Address,
  ]

  if (!TempoAddress.isEqual(payee, recipient)) {
    throw new VerificationFailedError({
      reason: 'open transaction payee does not match server recipient',
    })
  }
  if (!TempoAddress.isEqual(token, currency)) {
    throw new VerificationFailedError({
      reason: 'open transaction token does not match server currency',
    })
  }

  if (!transaction.from) throw new BadRequestError({ reason: 'open transaction has no sender' })

  const derivedChannelId = Channel.computeId({
    payer: transaction.from as `0x${string}`,
    payee,
    token,
    salt,
    authorizedSigner,
    escrowContract,
    chainId: client.chain!.id,
  })
  if (derivedChannelId.toLowerCase() !== channelId.toLowerCase())
    throw new VerificationFailedError({
      reason: 'open transaction does not match claimed channelId',
    })

  const resolvedFeeToken =
    transaction.feeToken ?? defaults.currency[client.chain?.id as keyof typeof defaults.currency]

  const serializedTransaction_final = await (async () => {
    if (feePayer) {
      return signTransaction(client, {
        ...transaction,
        account: feePayer,
        feePayer,
        feeToken: resolvedFeeToken,
      } as never)
    }
    return serializedTransaction
  })()

  if (!waitForConfirmation) {
    await call(client, {
      ...transaction,
      account: transaction.from,
      feeToken: resolvedFeeToken,
      calls,
    } as never)
    const txHash = await sendRawTransaction(client, {
      serializedTransaction: serializedTransaction_final as Transaction.TransactionSerializedTempo,
    })

    return {
      txHash,
      onChain: {
        finalized: false,
        closeRequestedAt: 0n,
        payer: transaction.from,
        payee,
        token,
        authorizedSigner,
        deposit,
        settled: 0n,
      } as OnChainChannel,
    }
  }

  let txHash: Hex | undefined
  try {
    const receipt = await sendRawTransactionSync(client, {
      serializedTransaction: serializedTransaction_final as Transaction.TransactionSerializedTempo,
    })

    if (receipt.status !== 'success') {
      throw new VerificationFailedError({
        reason: `open transaction reverted: ${receipt.transactionHash}`,
      })
    }

    txHash = receipt.transactionHash
  } catch (error) {
    const onChain = await getOnChainChannel(client, escrowContract, channelId)
    if (onChain.deposit > 0n) {
      return { txHash: undefined, onChain }
    }
    throw error
  }

  const onChain = await getOnChainChannel(client, escrowContract, channelId)

  return { txHash, onChain }
}

export async function broadcastTopUpTransaction(parameters: {
  client: Client
  serializedTransaction: Hex
  escrowContract: Address
  channelId: Hex
  currency: Address
  declaredDeposit: bigint
  previousDeposit: bigint
  feePayer?: Account | undefined
}): Promise<{ txHash: Hex; newDeposit: bigint }> {
  const {
    client,
    serializedTransaction,
    escrowContract,
    channelId,
    currency,
    declaredDeposit,
    previousDeposit,
    feePayer,
  } = parameters

  if (feePayer && !isTempoTransaction(serializedTransaction))
    throw new BadRequestError({
      reason: 'Only Tempo (0x76/0x78) transactions are supported',
    })

  const transaction = Transaction.deserialize(
    serializedTransaction as Transaction.TransactionSerializedTempo,
  )

  if (feePayer) assertSenderSigned(transaction)

  const calls = transaction.calls ?? []

  const topUpCall = calls.find((call) => {
    if (!call.to || !TempoAddress.isEqual(call.to, escrowContract)) return false
    if (!call.data) return false
    return call.data.slice(0, 10) === escrowTopUpSelector
  })

  if (!topUpCall)
    throw new BadRequestError({
      reason: 'transaction does not contain a valid escrow topUp call',
    })

  if (feePayer) {
    for (const call of calls) {
      if (!call.to || !call.data) {
        throw new BadRequestError({
          reason: 'fee-sponsored transactions must not contain calls without target or data',
        })
      }
      const selector = call.data.slice(0, 10)
      const isEscrowTopUp =
        TempoAddress.isEqual(call.to, escrowContract) && selector === escrowTopUpSelector
      const isTokenApprove =
        TempoAddress.isEqual(call.to, currency) && selector === erc20ApproveSelector
      if (!isEscrowTopUp && !isTokenApprove) {
        throw new BadRequestError({
          reason: 'fee-sponsored topUp transaction contains an unauthorized call',
        })
      }
    }
  }

  const { args: topUpArgs } = decodeFunctionData({ abi: escrowAbi, data: topUpCall.data! })
  const [txChannelId, txAmount] = topUpArgs as [Hex, bigint]

  if (txChannelId.toLowerCase() !== channelId.toLowerCase()) {
    throw new VerificationFailedError({
      reason: 'topUp transaction channelId does not match payload channelId',
    })
  }
  if (BigInt(txAmount) !== declaredDeposit) {
    throw new VerificationFailedError({
      reason: `topUp transaction amount (${txAmount}) does not match declared additionalDeposit (${declaredDeposit})`,
    })
  }

  const serializedTransaction_final = await (async () => {
    if (feePayer) {
      return signTransaction(client, {
        ...transaction,
        account: feePayer,
        feePayer,
        feeToken:
          transaction.feeToken ??
          defaults.currency[client.chain?.id as keyof typeof defaults.currency],
      } as never)
    }
    return serializedTransaction
  })()

  const receipt = await sendRawTransactionSync(client, {
    serializedTransaction: serializedTransaction_final as Transaction.TransactionSerializedTempo,
  })

  if (receipt.status !== 'success') {
    throw new VerificationFailedError({
      reason: `topUp transaction reverted: ${receipt.transactionHash}`,
    })
  }

  const onChain = await getOnChainChannel(client, escrowContract, channelId)

  if (onChain.deposit <= previousDeposit) {
    throw new VerificationFailedError({ reason: 'channel deposit did not increase after topUp' })
  }

  return { txHash: receipt.transactionHash, newDeposit: onChain.deposit }
}
