import {
  type Account,
  type Address,
  type Client,
  decodeFunctionData,
  encodeFunctionData,
  getAbiItem,
  type Hex,
  isAddressEqual,
  type ReadContractReturnType,
  toFunctionSelector,
} from 'viem'
import {
  prepareTransactionRequest,
  readContract,
  sendRawTransaction,
  sendRawTransactionSync,
  signTransaction,
  writeContract,
} from 'viem/actions'
import { Transaction } from 'viem/tempo'
import { BadRequestError, ChannelClosedError, VerificationFailedError } from '../../Errors.js'
import * as defaults from '../internal/defaults.js'
import { escrowAbi } from './escrow.abi.js'
import type { SignedVoucher } from './Types.js'

export { escrowAbi }

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
  // token.  `feePayer: true` tells the prepare hook to use expiring nonces but
  // does NOT set feeToken automatically, so we must provide it explicitly.
  const chainId = client.chain?.id
  const feeToken = chainId
    ? defaults.currency[chainId as keyof typeof defaults.currency]
    : undefined

  const prepared = await prepareTransactionRequest(client, {
    account: feePayer,
    calls: [{ to, data }],
    feePayer: true,
    ...(feeToken ? { feeToken } : {}),
  } as never)

  const serialized = (await signTransaction(client, {
    ...prepared,
    account: feePayer,
    feePayer,
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

/**
 * Validate and decode an open transaction's calls, returning the decoded
 * escrow open arguments plus the deserialized transaction.
 *
 * Shared by {@link broadcastOpenTransaction} and {@link validateAndSimulateOpen}.
 */
function validateOpenCalls(parameters: {
  serializedTransaction: Hex
  escrowContract: Address
  recipient: Address
  currency: Address
  feePayer?: Account | undefined
}) {
  const { serializedTransaction, escrowContract, recipient, currency, feePayer } = parameters

  const transaction = Transaction.deserialize(
    serializedTransaction as Transaction.TransactionSerializedTempo,
  )
  const calls = transaction.calls ?? []

  const openCall = calls.find((call) => {
    if (!call.to || !isAddressEqual(call.to, escrowContract)) return false
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
        isAddressEqual(call.to, escrowContract) && selector === escrowOpenSelector
      const isTokenApprove = isAddressEqual(call.to, currency) && selector === erc20ApproveSelector
      if (!isEscrowOpen && !isTokenApprove) {
        throw new BadRequestError({
          reason: 'fee-sponsored open transaction contains an unauthorized call',
        })
      }
    }
  }

  const { args: openArgs } = decodeFunctionData({ abi: escrowAbi, data: openCall.data! })
  const [payee, token, deposit, , authorizedSigner] = openArgs as readonly [
    Address,
    Address,
    bigint,
    Hex,
    Address,
  ]

  if (!isAddressEqual(payee, recipient)) {
    throw new VerificationFailedError({
      reason: 'open transaction payee does not match server recipient',
    })
  }
  if (!isAddressEqual(token, currency)) {
    throw new VerificationFailedError({
      reason: 'open transaction token does not match server currency',
    })
  }

  return {
    transaction,
    calls,
    openArgs: { payee, token, deposit, authorizedSigner },
  }
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
  const { client, serializedTransaction, escrowContract, channelId, feePayer, waitForConfirmation = true } = parameters
  const { transaction, calls, openArgs } = validateOpenCalls(parameters)

  // Per spec §7.1, when feePayer is set the server adds a 0x78
  // fee-payer signature before broadcasting.
  const serializedTransaction_final = await (async () => {
    if (feePayer) {
      return signTransaction(client, {
        ...transaction,
        account: feePayer,
        feePayer,
      } as never)
    }
    return serializedTransaction
  })()

  if (!waitForConfirmation) {
    // Simulate via eth_estimateGas to catch reverts before committing.
    const from = transaction.from as Address
    const simCalls = calls.map(
      (c: { to?: string; value?: bigint; data?: string }) => ({
        to: c.to,
        value: c.value ? `0x${c.value.toString(16)}` : '0x0',
        input: c.data ?? '0x',
      }),
    )
    await client.request({
      method: 'eth_estimateGas' as never,
      params: [
        {
          from,
          chainId: `0x${transaction.chainId.toString(16)}`,
          nonce: `0x${(transaction.nonce ?? 0n).toString(16)}`,
          gas: '0x2dc6c0', // 3M cap
          maxFeePerGas: `0x${(transaction.maxFeePerGas ?? 0n).toString(16)}`,
          maxPriorityFeePerGas: `0x${(transaction.maxPriorityFeePerGas ?? 0n).toString(16)}`,
          feeToken: transaction.feeToken,
          nonceKey: `0x${(transaction.nonceKey ?? 0n).toString(16)}`,
          calls: simCalls,
          ...(transaction.validBefore
            ? { validBefore: `0x${transaction.validBefore.toString(16)}` }
            : {}),
        },
      ] as never,
    })

    // Fire-and-forget the actual broadcast.
    sendRawTransaction(client, {
      serializedTransaction: serializedTransaction_final as Transaction.TransactionSerializedTempo,
    }).catch(() => {})

    return {
      txHash: undefined,
      onChain: {
        payer: from,
        payee: openArgs.payee,
        token: openArgs.token,
        authorizedSigner: openArgs.authorizedSigner,
        deposit: openArgs.deposit,
        settled: 0n,
        closeRequestedAt: 0n,
        finalized: false,
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

  const transaction = Transaction.deserialize(
    serializedTransaction as Transaction.TransactionSerializedTempo,
  )
  const calls = transaction.calls ?? []

  const topUpCall = calls.find((call) => {
    if (!call.to || !isAddressEqual(call.to, escrowContract)) return false
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
        isAddressEqual(call.to, escrowContract) && selector === escrowTopUpSelector
      const isTokenApprove = isAddressEqual(call.to, currency) && selector === erc20ApproveSelector
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
