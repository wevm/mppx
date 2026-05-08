import {
  type Account,
  type Address,
  type Client,
  decodeFunctionData,
  encodeFunctionData,
  erc20Abi,
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
} from 'viem/actions'
import { Transaction } from 'viem/tempo'

import { BadRequestError, ChannelClosedError, VerificationFailedError } from '../../Errors.js'
import * as TempoAddress from '../internal/address.js'
import * as defaults from '../internal/defaults.js'
import * as FeePayer from '../internal/fee-payer.js'
import { resolveFeeToken } from '../internal/fee-token.js'
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

/** Options for {@link settleOnChain}. */
export type SettleOptions =
  | { candidateFeeTokens?: readonly Address[] | undefined; feePayer: Account; account: Account }
  | {
      candidateFeeTokens?: readonly Address[] | undefined
      feePayer?: undefined
      account?: Account | undefined
    }

/**
 * Submit a settle transaction on-chain.
 */
export async function settleOnChain(
  client: Client,
  escrowContract: Address,
  voucher: SignedVoucher,
  options?: SettleOptions,
): Promise<Hex> {
  assertUint128(voucher.cumulativeAmount)
  const resolved = options?.account ?? client.account
  if (!resolved)
    throw new Error(
      'Cannot settle channel: no account available. Pass an `account` to tempo.settle(), or provide a `getClient` that returns an account-bearing client.',
    )
  const args = [voucher.channelId, voucher.cumulativeAmount, voucher.signature] as const
  if (options?.feePayer) {
    const data = encodeFunctionData({ abi: escrowAbi, functionName: 'settle', args })
    return sendFeePayerTx(
      client,
      resolved,
      options.feePayer,
      escrowContract,
      data,
      'settle',
      options.candidateFeeTokens,
    )
  }
  return sendAccountTx(
    client,
    resolved,
    escrowContract,
    encodeFunctionData({ abi: escrowAbi, functionName: 'settle', args }),
    'settle',
    options?.candidateFeeTokens,
  )
}

/** Options for {@link closeOnChain}. */
export type CloseOptions =
  | {
      candidateFeeTokens?: readonly Address[] | undefined
      feePayer: Account
      account: Account
    }
  | {
      candidateFeeTokens?: readonly Address[] | undefined
      feePayer?: undefined
      account?: Account | undefined
    }

/**
 * Submit a close transaction on-chain.
 */
export async function closeOnChain(
  client: Client,
  escrowContract: Address,
  voucher: SignedVoucher,
  options?: CloseOptions,
): Promise<Hex> {
  assertUint128(voucher.cumulativeAmount)
  const resolved = options?.account ?? client.account
  if (!resolved)
    throw new Error(
      'Cannot close channel: no account available. Pass an `account` (viem Account, e.g. privateKeyToAccount("0x...")) to tempo.session(), or provide a `getClient` that returns an account-bearing client.',
    )
  const args = [voucher.channelId, voucher.cumulativeAmount, voucher.signature] as const
  if (options?.feePayer) {
    const data = encodeFunctionData({ abi: escrowAbi, functionName: 'close', args })
    return sendFeePayerTx(
      client,
      resolved,
      options.feePayer,
      escrowContract,
      data,
      'close',
      options.candidateFeeTokens,
    )
  }
  return sendAccountTx(
    client,
    resolved,
    escrowContract,
    encodeFunctionData({ abi: escrowAbi, functionName: 'close', args }),
    'close',
    options?.candidateFeeTokens,
  )
}

async function sendAccountTx(
  client: Client,
  account: Account,
  to: Address,
  data: Hex,
  label: string,
  candidateFeeTokens?: readonly Address[] | undefined,
): Promise<Hex> {
  const feeToken = await resolveFeeToken({
    account: account.address,
    candidateTokens: candidateFeeTokens,
    client,
  })
  const prepared = await prepareTransactionRequest(client, {
    account,
    calls: [{ to, data }],
    ...(feeToken ? { feeToken } : {}),
  } as never)
  prepared.gas = prepared.gas! + 5_000n

  const serialized = (await signTransaction(client, {
    ...prepared,
    account,
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

/**
 * Build, sign, and broadcast a fee-sponsored type-0x76 transaction.
 *
 * Follows the same signTransaction + sendRawTransactionSync pattern used
 * by broadcastOpenTransaction / broadcastTopUpTransaction, but originates
 * the transaction server-side (estimating gas and fees first).
 *
 * @param account - The logical sender / msg.sender (e.g. the payee).
 * @param feePayer - The gas sponsor — only co-signs to cover fees.
 */
async function sendFeePayerTx(
  client: Client,
  account: Account,
  feePayer: Account,
  to: Address,
  data: Hex,
  label: string,
  candidateFeeTokens?: readonly Address[] | undefined,
): Promise<Hex> {
  const feeToken = await resolveFeeToken({
    account: feePayer.address,
    candidateTokens: candidateFeeTokens,
    client,
  })

  const prepared = await prepareTransactionRequest(client, {
    account,
    calls: [{ to, data }],
    feePayer: true,
    ...(feeToken ? { feeToken } : {}),
  } as never)

  const serialized = (await signTransaction(client, {
    ...prepared,
    account,
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

type TempoCall = NonNullable<ReturnType<(typeof Transaction)['deserialize']>['calls']>[number]

function assertCallHasTargetAndData(call: TempoCall): { to: Address; data: Hex } {
  if (!call.to || !call.data) {
    throw new BadRequestError({
      reason: 'fee-sponsored transactions must not contain calls without target or data',
    })
  }
  return { to: call.to, data: call.data }
}

function validateSponsoredApproveCall(parameters: {
  action: 'open' | 'topUp'
  call: TempoCall
  currency: Address
  escrowContract: Address
  expectedAmount: bigint
}) {
  const { action, call, currency, escrowContract, expectedAmount } = parameters
  const { to, data } = assertCallHasTargetAndData(call)

  if (!TempoAddress.isEqual(to, currency) || data.slice(0, 10) !== erc20ApproveSelector) {
    throw new BadRequestError({
      reason: `fee-sponsored ${action} transaction contains an unauthorized call`,
    })
  }

  const { args } = decodeFunctionData({ abi: erc20Abi, data })
  const [spender, amount] = args as readonly [Address, bigint]

  if (!TempoAddress.isEqual(spender, escrowContract)) {
    throw new BadRequestError({
      reason: `fee-sponsored ${action} transaction approve spender does not match escrow contract`,
    })
  }

  if (amount !== expectedAmount) {
    throw new BadRequestError({
      reason: `fee-sponsored ${action} transaction approve amount does not match requested amount`,
    })
  }
}

function validateSponsoredOpenCalls(parameters: {
  calls: readonly TempoCall[]
  currency: Address
  escrowContract: Address
  deposit: bigint
}) {
  const { calls, currency, escrowContract, deposit } = parameters

  let openCall: TempoCall | undefined
  let approveCall: TempoCall | undefined

  for (const call of calls) {
    const { to, data } = assertCallHasTargetAndData(call)
    const selector = data.slice(0, 10)
    const isOpen = TempoAddress.isEqual(to, escrowContract) && selector === escrowOpenSelector
    const isApprove = TempoAddress.isEqual(to, currency) && selector === erc20ApproveSelector

    if (isApprove) {
      if (approveCall || openCall) {
        throw new BadRequestError({
          reason: 'fee-sponsored open transaction contains a smuggled call',
        })
      }
      approveCall = call
      continue
    }

    if (isOpen) {
      if (openCall) {
        throw new BadRequestError({
          reason: 'fee-sponsored open transaction contains a smuggled call',
        })
      }
      openCall = call
      continue
    }

    throw new BadRequestError({
      reason: 'fee-sponsored open transaction contains an unauthorized call',
    })
  }

  if (approveCall) {
    validateSponsoredApproveCall({
      action: 'open',
      call: approveCall,
      currency,
      escrowContract,
      expectedAmount: deposit,
    })
  }

  return openCall
}

function validateSponsoredTopUpCalls(parameters: {
  calls: readonly TempoCall[]
  currency: Address
  escrowContract: Address
  topUpAmount: bigint
}) {
  const { calls, currency, escrowContract, topUpAmount } = parameters

  let topUpCall: TempoCall | undefined
  let approveCall: TempoCall | undefined

  for (const call of calls) {
    const { to, data } = assertCallHasTargetAndData(call)
    const selector = data.slice(0, 10)
    const isTopUp = TempoAddress.isEqual(to, escrowContract) && selector === escrowTopUpSelector
    const isApprove = TempoAddress.isEqual(to, currency) && selector === erc20ApproveSelector

    if (isApprove) {
      if (approveCall || topUpCall) {
        throw new BadRequestError({
          reason: 'fee-sponsored topUp transaction contains a smuggled call',
        })
      }
      approveCall = call
      continue
    }

    if (isTopUp) {
      if (topUpCall) {
        throw new BadRequestError({
          reason: 'fee-sponsored topUp transaction contains a smuggled call',
        })
      }
      topUpCall = call
      continue
    }

    throw new BadRequestError({
      reason: 'fee-sponsored topUp transaction contains an unauthorized call',
    })
  }

  if (approveCall) {
    validateSponsoredApproveCall({
      action: 'topUp',
      call: approveCall,
      currency,
      escrowContract,
      expectedAmount: topUpAmount,
    })
  }

  return topUpCall
}

export async function broadcastOpenTransaction(parameters: {
  client: Client
  serializedTransaction: Hex
  escrowContract: Address
  channelId: Hex
  recipient: Address
  currency: Address
  challengeExpires?: string | undefined
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
  feePayer?: Account | undefined
  beforeBroadcast?: ((onChain: OnChainChannel) => Promise<void> | void) | undefined
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
    challengeExpires,
    feePayerPolicy,
    feePayer,
    beforeBroadcast,
    waitForConfirmation = true,
  } = parameters

  if (feePayer && !FeePayer.isTempoTransaction(serializedTransaction))
    throw new BadRequestError({
      reason: 'Only Tempo (0x76/0x78) transactions are supported',
    })

  const transaction = Transaction.deserialize(
    serializedTransaction as Transaction.TransactionSerializedTempo,
  )

  if (feePayer) assertSenderSigned(transaction)

  const calls = transaction.calls ?? []

  const sponsoredOpenCall = feePayer
    ? validateSponsoredOpenCalls({
        calls,
        currency,
        escrowContract,
        deposit: (() => {
          const candidate = calls.find((call) => {
            if (!call.to || !TempoAddress.isEqual(call.to, escrowContract)) return false
            if (!call.data) return false
            return call.data.slice(0, 10) === escrowOpenSelector
          })
          if (!candidate?.data)
            throw new BadRequestError({
              reason: 'transaction does not contain a valid escrow open call',
            })
          const { args } = decodeFunctionData({ abi: escrowAbi, data: candidate.data })
          return (args as readonly [Address, Address, bigint, Hex, Address])[2]
        })(),
      })
    : undefined

  const openCall =
    sponsoredOpenCall ??
    calls.find((call) => {
      if (!call.to || !TempoAddress.isEqual(call.to, escrowContract)) return false
      if (!call.data) return false
      return call.data.slice(0, 10) === escrowOpenSelector
    })

  if (!openCall)
    throw new BadRequestError({
      reason: 'transaction does not contain a valid escrow open call',
    })

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

  const pendingOnChain = {
    finalized: false,
    closeRequestedAt: 0n,
    payer: transaction.from,
    payee,
    token,
    authorizedSigner,
    deposit,
    settled: 0n,
  } as OnChainChannel

  await beforeBroadcast?.(pendingOnChain)

  const serializedTransaction_final = await (async () => {
    if (feePayer) {
      if (!sponsoredOpenCall)
        throw new BadRequestError({
          reason: 'transaction does not contain a valid escrow open call',
        })

      const sponsored = FeePayer.prepareSponsoredTransaction({
        account: feePayer,
        challengeExpires,
        chainId: client.chain!.id,
        details: { channelId, currency, recipient },
        expectedFeeToken: defaults.currency[client.chain?.id as keyof typeof defaults.currency],
        policy: feePayerPolicy,
        transaction: {
          ...transaction,
          ...(resolvedFeeToken ? { feeToken: resolvedFeeToken } : {}),
        },
      })
      return signTransaction(client, sponsored as never)
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
      onChain: pendingOnChain,
    }
  }

  let txHash: Hex | undefined
  try {
    if (feePayer)
      await call(client, {
        ...transaction,
        account: transaction.from,
        feeToken: resolvedFeeToken,
        calls,
      } as never)

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
  challengeExpires?: string | undefined
  feePayerPolicy?: Partial<FeePayer.Policy> | undefined
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
    challengeExpires,
    feePayerPolicy,
    feePayer,
  } = parameters

  if (feePayer && !FeePayer.isTempoTransaction(serializedTransaction))
    throw new BadRequestError({
      reason: 'Only Tempo (0x76/0x78) transactions are supported',
    })

  const transaction = Transaction.deserialize(
    serializedTransaction as Transaction.TransactionSerializedTempo,
  )

  if (feePayer) assertSenderSigned(transaction)

  const calls = transaction.calls ?? []

  const sponsoredTopUpCall = feePayer
    ? validateSponsoredTopUpCalls({
        calls,
        currency,
        escrowContract,
        topUpAmount: declaredDeposit,
      })
    : undefined

  const topUpCall =
    sponsoredTopUpCall ??
    calls.find((call) => {
      if (!call.to || !TempoAddress.isEqual(call.to, escrowContract)) return false
      if (!call.data) return false
      return call.data.slice(0, 10) === escrowTopUpSelector
    })

  if (!topUpCall)
    throw new BadRequestError({
      reason: 'transaction does not contain a valid escrow topUp call',
    })

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
      if (!sponsoredTopUpCall)
        throw new BadRequestError({
          reason: 'transaction does not contain a valid escrow topUp call',
        })

      const expectedFeeToken = defaults.currency[client.chain?.id as keyof typeof defaults.currency]
      const sponsored = FeePayer.prepareSponsoredTransaction({
        account: feePayer,
        challengeExpires,
        chainId: client.chain!.id,
        details: {
          additionalDeposit: declaredDeposit.toString(),
          channelId,
          currency,
        },
        expectedFeeToken,
        policy: feePayerPolicy,
        transaction: {
          ...transaction,
          ...((transaction.feeToken ?? expectedFeeToken)
            ? { feeToken: transaction.feeToken ?? expectedFeeToken }
            : {}),
        },
      })
      return signTransaction(client, sponsored as never)
    }
    return serializedTransaction
  })()

  if (feePayer)
    await call(client, {
      ...transaction,
      account: transaction.from,
      feeToken:
        transaction.feeToken ??
        defaults.currency[client.chain?.id as keyof typeof defaults.currency],
      calls,
    } as never)

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
